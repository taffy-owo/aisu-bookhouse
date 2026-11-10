"""Production stage adapter: durable diagnostics, lane serialization and fencing."""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import time
import json
import hashlib
import math
from dataclasses import replace

from app.core.config import Settings
from app.core.ai_credentials import is_platform_ai_credential
from app.modules.translations.ai import ProviderUnavailableError, call_budget_for

from .pilot import TrialClient, TrialError, PROMPTS, digest, save_json
from .context import CONTEXT_PROMPT
from .request_budget import release_unsent, reserve
from .checkpoints import load_provider_receipt

PROMPTS['context'] = CONTEXT_PROMPT

STAGES = {'context': '正在整理原文与规范译名', 'analysis': '正在分析说话人和指代',
          'draft': '正在翻译并自校', 'edit': '正在中文编辑', 'proofread': '正在校对',
          'review': '正在双语质检', 'repair': '正在修复具体问题'}
ERRORS = {'authentication_failed': '渠道鉴权失败（HTTP 401）',
          'block_coverage_mismatch': '模型返回的段落或质检编号不完整',
          'context_coverage_mismatch': '原文规划的逐段检查清单不完整',
          'term_evidence_invalid': '术语候选与所引用的原文不对应',
          'channel_cooling_down': '渠道正处于限流冷却期，本次未请求模型',
          'http_forbidden': '渠道禁止访问（HTTP 403）',
          'http_error': 'AI 渠道请求失败',
          'rate_or_quota_limited': '渠道限流或额度不足（HTTP 429）',
          'empty_response': '渠道没有返回正文', 'truncated_output': '渠道标记输出被截断',
          'invalid_json': '渠道返回的内容不是有效 JSON', 'schema_mismatch': '响应字段不符合本阶段契约',
          'provider_rejected': '模型因内容政策拒绝了本次请求，未生成译文', 'provider_payload_unusable': '渠道响应无法使用',
          'transport_outcome_unknown': '请求超时或网络中断，是否计费未知',
          'term_conflict': '新提议的译名与已锁定译名冲突', 'quality_blocked': '质检发现尚未解决的问题',
          'lease_lost': '任务已由其他工作器接管', 'paused': '任务已暂停',
          'source_changed': '原文快照发生变化，需要重新确认',
          'publication_conflict': '图书在处理期间被修改，未覆盖原书'}
ERRORS.update(request_budget_exhausted='本章请求次数已达上限，已保留检查点；请检查渠道后调整预算',
              untranslated_source='渠道多次返回日文原文，未完成实际翻译',
              request_budget_unavailable='请求预算记录不可读写，未发送新请求',
              checkpoint_corrupt='检查点记录损坏，未重新请求或覆盖记录',
              checkpoint_schema_invalid='检查点与当前输出格式不匹配，未重新请求或覆盖记录',
              receipt_corrupt='请求回执损坏，未重新请求或覆盖记录')
ERRORS['publication_approval_required'] = '更新译稿尚未获得你的接受确认，原书未修改'
ERRORS['source_publication_conflict'] = '来源章节已入库或存在其他翻译任务，请先核验并对账，原书未重复追加'
ERRORS['platform_budget_exhausted'] = '全站 AI 日调用次数已达上限，本次未请求模型'
ERRORS['unsafe_provider_address'] = 'AI 渠道域名解析到了不安全的地址，未发送请求'


@asynccontextmanager
async def lane_lock(root: Path, identity: str, guard, capacity=1):
    """POSIX advisory locks are released by the OS on worker crash.

    Slot locks bound actual in-flight requests across worker processes. This is
    not an RPM quota: no unverified daily allowance is invented.
    """
    import fcntl
    directory = root / 'lanes'
    directory.mkdir(parents=True, exist_ok=True)
    handle = None
    try:
        while True:
            guard()
            for slot in range(max(1, min(16, capacity))):
                suffix = '' if slot == 0 else f'-{slot}'
                probe = (directory / (digest(identity) + suffix + '.lock')).open('a+b')
                try:
                    fcntl.flock(probe.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    handle = probe
                    break
                except BlockingIOError:
                    probe.close()
            if handle is not None:
                break
            await asyncio.sleep(0.1)
        yield
    finally:
        if handle is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()
    # Give an already-waiting process one polling interval to acquire the lane
    # before this book immediately requests its next stage and monopolizes it.
    await asyncio.sleep(0.55)


class StageClient(TrialClient):
    def __init__(self, *args, guard, report, lane_root: Path, capacity=1, repair_retry_attempt=0,
                 budget_path=None, budget_scope=None, request_limit=24, platform_settings: Settings | None = None,
                 model_daily_allowance=0, **kwargs):
        super().__init__(*args, **kwargs)
        self.guard, self.report, self.lane_root = guard, report, lane_root
        self.capacity = max(1, min(16, capacity))
        self.repair_retry_attempt = max(0, int(repair_retry_attempt or 0))
        self.budget_path = Path(budget_path) if budget_path is not None else self.root / 'request-budget.sqlite3'
        self.budget_scope = budget_scope or 'unit'
        self.request_limit = request_limit
        self.platform_settings = platform_settings
        self.model_daily_allowance = max(0, int(model_daily_allowance))
        self.secure_outbound = True
        credential_hash = hashlib.sha256(self.api_key.encode()).hexdigest()
        self.cooldown_path = lane_root / 'cooldowns' / (digest([self.endpoint, self.model, credential_hash]) + '.json')

    def cooldown(self):
        return json.loads(self.cooldown_path.read_text(encoding='utf-8')) if self.cooldown_path.exists() else {}

    def before_request(self):
        self.guard()
        remaining = math.ceil(float(self.cooldown().get('not_before', 0)) - time.time())
        if remaining > 0:
            raise TrialError('channel_cooling_down', retry_after_seconds=remaining)

    def record_rate_limit(self, error):
        streak = int(self.cooldown().get('streak', 0)) + 1
        delay = max(min(30 * 2 ** min(streak - 1, 6), 1800),
                    int(error.details.get('retry_after_seconds') or 0))
        save_json(self.cooldown_path, {'not_before': time.time() + delay, 'streak': streak})
        error.details['retry_after_seconds'] = delay

    async def reserve_request(self, stage, fingerprint):
        self.guard()
        job_reservation = reserve(self.budget_path, self.budget_scope, self.request_limit, stage, fingerprint)
        if (self.platform_settings and is_platform_ai_credential(self.api_key, self.platform_settings)
                and (self.platform_settings.ai_translation_global_daily_call_budget > 0 or self.model_daily_allowance > 0)):
            channel_settings = replace(
                self.platform_settings, ai_translation_base_url=self.endpoint, ai_translation_api_key=self.api_key
            )
            try:
                allowed = await call_budget_for(channel_settings).reserve(
                    self.model, self.model_daily_allowance,
                    global_allowance=self.platform_settings.ai_translation_global_daily_call_budget,
                )
            except ProviderUnavailableError as error:
                release_unsent(self.budget_path, self.budget_scope, job_reservation['reservation_id'])
                raise TrialError('request_budget_unavailable', stage=stage) from error
            if not allowed:
                release_unsent(self.budget_path, self.budget_scope, job_reservation['reservation_id'])
                raise TrialError('platform_budget_exhausted', stage=stage)
        return job_reservation

    async def call_with_contract_correction(self, stage, payload, schema):
        # Register corrective inputs BEFORE sending. On resume, probe their
        # existing receipts/checkpoints before replaying the failed base input.
        # This also closes the crash window between checkpoint and alias writes.
        identity = digest({'endpoint': self.endpoint, 'body': self.request_body(stage, payload, schema)})
        index_path = self.root / 'corrections' / (stage + '-' + identity + '.json')
        corrections = []
        if index_path.exists():
            try:
                saved = json.loads(index_path.read_text(encoding='utf-8'))
                corrections = saved['corrections']
                if (saved['fingerprint'] != identity or not isinstance(corrections, list)
                        or saved['hash'] != digest(corrections)
                        or any(not isinstance(c, dict) for c in corrections)):
                    raise ValueError('invalid correction index')
            except (ValueError, KeyError, TypeError) as error:
                raise TrialError('checkpoint_corrupt', stage=stage) from error
            for correction in reversed(corrections):
                shaped = {**payload, 'response_contract_correction': correction}
                fingerprint = digest({'endpoint': self.endpoint, 'body': self.request_body(stage, shaped, schema)})
                checkpoint = self.root / 'checkpoints' / (stage + '-' + fingerprint + '.json')
                raw = self.root / 'receipts' / (stage + '-' + fingerprint + '.json')
                reusable = checkpoint.exists()
                if not reusable and raw.exists():
                    receipt = load_provider_receipt(raw, fingerprint, stage=stage)
                    reusable = receipt.get('status') == 200 and not receipt.get('decode_failed')
                if reusable:
                    try:
                        return await super().call(stage, shaped, schema)
                    except TrialError as error:
                        if error.code not in {'invalid_json', 'schema_mismatch'}:
                            raise
        correction = None
        for attempt in range(3):
            shaped_payload = payload if correction is None else {**payload, 'response_contract_correction': correction}
            if correction is not None and correction not in corrections:
                corrections.append(correction)
                save_json(index_path, {'fingerprint': identity, 'corrections': corrections, 'hash': digest(corrections)})
            try:
                return await super().call(stage, shaped_payload, schema)
            except TrialError as error:
                if error.code not in {'invalid_json', 'schema_mismatch'} or attempt == 2:
                    raise
                correction = {'attempt':attempt+1, 'error_code':error.code,
                    'allowed_top_level_fields':list(schema.model_fields),
                    'issues':error.details.get('issues', [])[:8],
                    'instruction':'之前响应不是有效 JSON 或字段不符合契约。重新完成本阶段，严格按照 output_schema，只输出 JSON 对象，不回显输入、workflow_version 或其他多余字段。字符串内引号和换行必须正确转义。'}
                self.report(stage, STAGES[stage] + f' · 修正响应格式 {attempt+1}/2')

    async def call(self, stage, payload, schema):
        self.guard()
        self.report(stage, STAGES[stage])
        # Pin the protocol version alongside prompts/context in every cache key.
        payload = {**payload, 'workflow_version': 'v2.1'}
        if stage == 'repair' and self.repair_retry_attempt:
            # Explicit job retries must not replay the same unsuccessful patch
            # forever. Keep draft/review identities, and keep this repair key
            # stable across worker restarts and automatic transport retries.
            payload = {**payload, 'repair_retry_attempt': self.repair_retry_attempt}
        try:
            lock_args = {} if self.capacity == 1 else {'capacity': self.capacity}
            async with lane_lock(self.lane_root, self.endpoint + '|' + self.model, self.guard, **lock_args):
                try:
                    output = await self.call_with_contract_correction(stage, payload, schema)
                except TrialError as error:
                    if error.code == 'rate_or_quota_limited':
                        self.record_rate_limit(error)
                    raise
                # A sibling may have received 429 while this request succeeded.
                # Do not clear its active cooldown.
                if (self.events[-1].get('calls') and self.cooldown_path.exists()
                        and float(self.cooldown().get('not_before', 0)) <= time.time()):
                    save_json(self.cooldown_path, {'not_before': 0, 'streak': 0})
            self.guard()
            save_json(self.root / 'last-stage.json', {'stage': stage, 'status': 'completed',
                                                     'event': self.events[-1]})
            return output
        except TrialError as error:
            error.details.setdefault('stage', stage)
            error.details.setdefault('fingerprint', digest({'stage': stage,
                'body': self.request_body(stage, payload, schema), 'endpoint': self.endpoint}))
            save_json(self.root / 'failure.json', {'stage': stage, 'code': error.code,
                'details': error.details, 'event': self.events[-1] if self.events else {}, 'time': time.time()})
            raise


def error_message(error: TrialError) -> str:
    message = ERRORS.get(error.code, '本阶段验证失败') + ' [' + error.code + ']'
    if error.code == 'request_budget_exhausted':
        message += f" · {error.details.get('used')}/{error.details.get('limit')} 次"
    if error.code == 'patch_version_conflict':
        message = '模型补丁返回了不匹配的版本令牌，未覆盖候选稿 [patch_version_conflict]'
        if error.details.get('corrective_attempts'):
            message += ' · 已针对当前原稿纠正 2 次'
    if error.code == 'http_error' and error.details.get('http_status') == 524:
        message = '上游网关等待源站响应超时 [http_error]'
    if error.details.get('stage') in STAGES:
        message += ' · ' + STAGES[error.details['stage']]
    if isinstance(error.details.get('http_status'), int):
        message += f" · HTTP {error.details['http_status']}"
    if error.code in {'block_coverage_mismatch', 'context_coverage_mismatch'}:
        if all(isinstance(error.details.get(k), int) for k in ('expected','received')):
            message += f" · 应有 {error.details['expected']} 项，返回 {error.details['received']} 项"
        missing = error.details.get('missing_ids')
        if isinstance(missing, list) and missing:
            message += ' · 漏项 ' + ','.join(str(i)[:30] for i in missing[:3])
    if error.code == 'transport_outcome_unknown':
        kind = error.details.get('error_type')
        if kind in {'ReadTimeout', 'ConnectTimeout', 'WriteTimeout', 'PoolTimeout',
                    'TimeoutError', 'ReadError', 'ConnectError', 'RemoteProtocolError'}:
            message += ' · ' + kind
        elapsed = error.details.get('elapsed_seconds')
        if isinstance(elapsed, (int, float)):
            message += f' · 等待 {elapsed:g} 秒'
        if error.details.get('transport_phase') == 'waiting_headers':
            message += ' · 尚未收到响应头'
        received = error.details.get('response_bytes')
        if isinstance(received, int):
            message += f' · 已接收 {received} 字节'
    issues = error.details.get('issues', [])
    if isinstance(issues, list):
        for item in issues[:3]:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get('loc'), list):
                message += ' · ' + '.'.join(map(str, item['loc']))[:60] + ':' + str(item.get('type', ''))[:40]
            elif item.get('block_id') and item.get('code'):
                message += ' · ' + str(item['block_id'])[:40] + ':' + str(item['code'])[:50]
    # No raw provider body, credentials or chapter prose in the task card.
    if error.details.get('block_id'):
        message += ' · ' + str(error.details['block_id'])[:60]
    diagnostics = error.details.get('diagnostics', {})
    if isinstance(diagnostics, dict):
        for key in ('signal', 'reason', 'http_status', 'request_id'):
            value = diagnostics.get(key)
            if isinstance(value, (str, int)) and len(str(value)) <= 120:
                message += f' · {key}={value}'
    return message[:480]


MAX_INPUT_RETRIES = 5


def retry_delay(error: TrialError, root: Path) -> int | None:
    """Bounded retries per failed input, shared across nested passes."""
    # Exhausting the immediate format corrections is not proof of a permanent
    # failure. Gateways can produce a valid shape on a later fresh request.
    # Share the existing per-input budget across all transient error types.
    retryable = error.code in {'transport_outcome_unknown', 'empty_response', 'invalid_json',
                              'schema_mismatch', 'provider_payload_unusable'}
    retryable |= error.code == 'http_error' and error.details.get('http_status', 0) in {408, 500, 502, 503, 504, 520, 521, 522, 523, 524}
    fingerprint = error.details.get('fingerprint')
    if not retryable or not fingerprint:
        return None
    import json
    path = root / 'retry-budget.json'
    budgets = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    count = int(budgets.get(fingerprint, 0))
    if count >= MAX_INPUT_RETRIES:
        return None
    budgets[fingerprint] = count + 1
    save_json(path, budgets)
    return max(30 * (count + 1), int(error.details.get('retry_after_seconds') or 0))
