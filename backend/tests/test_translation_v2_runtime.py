import asyncio
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import socket
import sqlite3

import httpx
import pytest

from app.core.config import Settings
from app.modules.translations.ai import DailyCallBudget, platform_model_allowance

from app.modules.translation_v2 import pilot, runtime
from app.modules.translation_v2.pilot import TrialError, TrialClient, Draft, save_json
from app.modules.translation_v2.context import ContextPlan, merge_terms
from app.modules.translation_v2.pilot import SourceBlock


def make_client(root, *, key='test-key', model='model'):
    return runtime.StageClient('https://example.test/v1', key, model, root / 'task',
        guard=lambda: None, report=lambda *a: None, lane_root=root / 'shared')


def test_rate_limit_is_shared_by_credential_but_not_other_accounts(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime.time, 'time', lambda: 1000.)
    client = make_client(tmp_path)
    for expected in [30, 60, 120, 240, 480, 960, 1800, 1800]:
        error = TrialError('rate_or_quota_limited')
        client.record_rate_limit(error)
        assert error.details['retry_after_seconds'] == expected
    with pytest.raises(TrialError, match='channel_cooling_down'):
        make_client(tmp_path).before_request()
    make_client(tmp_path, key='another-key').before_request()
    make_client(tmp_path, model='another-model').before_request()
    error = TrialError('rate_or_quota_limited', retry_after_seconds=7200)
    client.record_rate_limit(error)
    assert error.details['retry_after_seconds'] == 7200
    assert 'test-key' not in client.cooldown_path.name


def test_cooldown_blocks_paid_requests_but_not_cached_work(tmp_path, monkeypatch):
    @asynccontextmanager
    async def unlocked(*args):
        yield
    monkeypatch.setattr(runtime, 'lane_lock', unlocked)
    calls = []
    async def send(self, body, event, stage):
        calls.append(stage)
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps({
            'blocks': [{'block_id': 'p1', 'segments': [{'text': '她回家。', 'break_after': 'none'}]}]})}, 'finish_reason': 'stop'}]})
    monkeypatch.setattr(TrialClient, 'send', send)
    client = make_client(tmp_path)
    one = asyncio.run(client.call('draft', {'example': 1}, Draft))
    client.record_rate_limit(TrialError('rate_or_quota_limited'))
    assert asyncio.run(client.call('draft', {'example': 1}, Draft)) == one
    with pytest.raises(TrialError, match='channel_cooling_down'):
        asyncio.run(client.call('draft', {'example': 2}, Draft))
    assert calls == ['draft'] and client.events[-1]['calls'] == 0
    assert client.cooldown()['streak'] == 1  # Cached success doesn't reset upstream cooldown.


def test_v2_calls_share_the_platform_daily_cap_and_fail_closed(tmp_path, monkeypatch):
    @asynccontextmanager
    async def unlocked(*_args):
        yield
    monkeypatch.setattr(runtime, 'lane_lock', unlocked)
    calls = []
    async def send(self, body, event, stage):
        calls.append(stage)
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps({
            'blocks': [{'block_id': 'p1', 'segments': [{'text': '她回家。', 'break_after': 'none'}]}]})}, 'finish_reason': 'stop'}]})
    monkeypatch.setattr(TrialClient, 'send', send)
    settings = Settings(storage_root=str(tmp_path), ai_translation_global_daily_call_budget=1,
                        ai_platform_builtin_api_key='test-key')
    client = runtime.StageClient('https://example.test/v1', 'test-key', 'model', tmp_path / 'task',
        guard=lambda: None, report=lambda *_args: None, lane_root=tmp_path / 'shared',
        platform_settings=settings)
    asyncio.run(client.call('draft', {'example': 1}, Draft))
    with pytest.raises(TrialError, match='platform_budget_exhausted'):
        asyncio.run(client.call('draft', {'example': 2}, Draft))
    assert calls == ['draft']
    with sqlite3.connect(client.budget_path) as db:
        assert db.execute('SELECT count(*) FROM reservations').fetchone()[0] == 1

    unavailable = tmp_path / 'ai-call-usage.sqlite3'
    unavailable.unlink()
    unavailable.mkdir()
    with pytest.raises(TrialError, match='request_budget_unavailable'):
        asyncio.run(client.call('draft', {'example': 3}, Draft))
    assert calls == ['draft']
    with sqlite3.connect(client.budget_path) as db:
        assert db.execute('SELECT count(*) FROM reservations').fetchone()[0] == 1


def test_production_v2_provider_uses_pinned_public_https_transport(tmp_path, monkeypatch):
    observed = []
    def safe_client(*, timeout):
        observed.append(timeout)
        return httpx.AsyncClient(
            timeout=timeout, transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={}))
        )
    monkeypatch.setattr(pilot, 'public_https_client', safe_client)
    response = asyncio.run(make_client(tmp_path).send({}, {}, 'draft'))
    assert response.status_code == 200
    assert len(observed) == 1


def test_v2_private_dns_answer_is_a_terminal_provider_error(tmp_path, monkeypatch):
    @asynccontextmanager
    async def unlocked(*_args):
        yield
    monkeypatch.setattr(runtime, 'lane_lock', unlocked)
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))
    ])
    with pytest.raises(TrialError, match='unsafe_provider_address'):
        asyncio.run(make_client(tmp_path).call('draft', {'example': 1}, Draft))


def test_v2_respects_calls_already_reserved_by_legacy_translation(tmp_path, monkeypatch):
    @asynccontextmanager
    async def unlocked(*_args):
        yield
    monkeypatch.setattr(runtime, 'lane_lock', unlocked)
    settings = Settings(storage_root=str(tmp_path), ai_translation_global_daily_call_budget=1,
                        ai_platform_builtin_api_key='test-key')
    assert asyncio.run(DailyCallBudget(tmp_path / 'ai-call-usage.sqlite3', 'legacy').reserve(
        'legacy-model', 0, global_allowance=1
    ))
    client = runtime.StageClient('https://example.test/v1', 'test-key', 'model', tmp_path / 'task',
        guard=lambda: None, report=lambda *_args: None, lane_root=tmp_path / 'shared',
        platform_settings=settings)
    with pytest.raises(TrialError, match='platform_budget_exhausted'):
        asyncio.run(client.call('draft', {'example': 1}, Draft))
    with sqlite3.connect(client.budget_path) as db:
        assert db.execute('SELECT count(*) FROM reservations').fetchone()[0] == 0


def test_v2_enforces_builtin_model_allowance_shared_with_legacy(tmp_path, monkeypatch):
    @asynccontextmanager
    async def unlocked(*_args):
        yield
    monkeypatch.setattr(runtime, 'lane_lock', unlocked)
    settings = Settings(
        storage_root=str(tmp_path), ai_translation_model='primary', ai_translation_daily_call_budget=1,
        ai_translation_global_daily_call_budget=5, ai_platform_builtin_api_key='test-key',
    )
    channel_settings = Settings(storage_root=str(tmp_path), ai_translation_base_url='https://example.test/v1', ai_translation_api_key='test-key')
    from app.modules.translations.ai import call_budget_for
    assert asyncio.run(call_budget_for(channel_settings).reserve('primary', 1, global_allowance=5))
    client = runtime.StageClient('https://example.test/v1', 'test-key', 'primary', tmp_path / 'task',
        guard=lambda: None, report=lambda *_args: None, lane_root=tmp_path / 'shared',
        platform_settings=settings, model_daily_allowance=platform_model_allowance('primary', settings, credential_key='test-key'))
    with pytest.raises(TrialError, match='platform_budget_exhausted'):
        asyncio.run(client.call('draft', {'example': 1}, Draft))
    with sqlite3.connect(client.budget_path) as db:
        assert db.execute('SELECT count(*) FROM reservations').fetchone()[0] == 0


def test_user_channel_does_not_inherit_builtin_model_cap():
    settings = Settings(ai_translation_model='same-name', ai_translation_daily_call_budget=200,
                        ai_platform_builtin_api_key='platform-key')
    assert platform_model_allowance('same-name', settings, credential_key='platform-key') == 200
    assert platform_model_allowance('same-name', settings, credential_key='personal-key') == 0

def test_atomic_checkpoints_do_not_share_temporary_files(tmp_path):
    path = tmp_path / 'checkpoint.json'
    def write(n):
        save_json(path, {'number': n, 'values': [n] * 1000})
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(write, range(50)))
    result = json.loads(path.read_text(encoding='utf-8'))
    assert result['values'] == [result['number']] * 1000
    assert not list(tmp_path.glob('*.tmp'))


@pytest.mark.skipif(os.name != 'posix' or getattr(os, 'geteuid', lambda: -1)() != 0,
                    reason='Requires POSIX root to reproduce administrator/service ownership')
def test_root_checkpoint_write_remains_private_and_readable_by_storage_owner():
    import pwd
    import subprocess
    import sys
    import tempfile
    account = pwd.getpwnam('nobody')
    with tempfile.TemporaryDirectory(prefix='aisu-ownership-') as directory:
        root = Path(directory)
        os.chown(root, account.pw_uid, account.pw_gid)
        path = root / 'new' / 'nested' / 'translation-context.json'
        for version in (1, 2):
            save_json(path, {'version': version})
            assert path.stat().st_uid == account.pw_uid
            assert path.stat().st_gid == account.pw_gid
            assert path.stat().st_mode & 0o777 == 0o600
            assert path.parent.stat().st_uid == account.pw_uid
            def drop_privileges():
                os.setgroups([])
                os.setgid(account.pw_gid)
                os.setuid(account.pw_uid)
            result = subprocess.run([sys.executable, '-c',
                'import json,sys; print(json.load(open(sys.argv[1]))["version"])', str(path)],
                cwd='/', preexec_fn=drop_privileges, capture_output=True, text=True)
            assert result.returncode == 0, result.stderr
            assert result.stdout.strip() == str(version)
        assert not list(root.rglob('*.tmp'))


def test_rejected_term_proposal_cannot_replace_locked_canonical_name():
    source = [SourceBlock(block_id='p1', text='シルヴィアは笑った。')]
    locked = [{'source': 'シルヴィア', 'target': '西尔维娅'}]
    plan = ContextPlan(checked_block_ids=['p1'], terms=[{
        'source': 'シルヴィア', 'target': '希尔维娅', 'evidence_block_id': 'p1',
        'evidence_quote': 'シルヴィア', 'note': ''}], summary='', voice_notes=[], uncertainties=[])
    rejected = []
    assert merge_terms(locked, plan, source, proposal_conflicts=rejected) == locked
    assert rejected == [{'source': 'シルヴィア', 'kept': '西尔维娅', 'proposed': '希尔维娅', 'block_id': 'p1'}]
    assert locked[0]['target'] == '西尔维娅'


def test_transport_waits_longer_but_keeps_idle_and_total_bounds(tmp_path, monkeypatch):
    real_client = httpx.AsyncClient
    settings = []
    def factory(**kwargs):
        settings.append(kwargs['timeout'])
        async def respond(request):
            raise httpx.ReadTimeout('secret must not escape')
        return real_client(**kwargs, transport=httpx.MockTransport(respond))
    monkeypatch.setattr(httpx, 'AsyncClient', factory)
    client = TrialClient('https://example.test/v1', 'test-key', 'model', tmp_path)
    with pytest.raises(TrialError) as failure:
        asyncio.run(client.call('draft', {}, Draft))
    error = failure.value
    assert error.code == 'transport_outcome_unknown'
    assert settings[0].read == 240 and settings[0].connect == 15
    assert error.details['total_timeout_seconds'] == 600
    assert error.details['transport_phase'] == 'waiting_headers'
    message = runtime.error_message(error)
    assert 'ReadTimeout' in message and '尚未收到响应头' in message and '0 字节' in message
    assert 'secret' not in message and 'test-key' not in message
    assert not list((tmp_path / 'checkpoints').glob('*.json'))


def test_stream_heartbeats_cannot_extend_absolute_deadline(tmp_path, monkeypatch):
    real_client = httpx.AsyncClient
    class EndlessStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            while True:
                yield b': heartbeat\n\n'
                await asyncio.sleep(.005)
    def factory(**kwargs):
        async def respond(request):
            return httpx.Response(200, stream=EndlessStream())
        return real_client(**kwargs, transport=httpx.MockTransport(respond))
    monkeypatch.setattr(httpx, 'AsyncClient', factory)
    client = TrialClient('https://example.test/v1', 'test-key', 'model', tmp_path)
    client.TOTAL_TIMEOUT_SECONDS = .025
    with pytest.raises(TrialError) as failure:
        asyncio.run(client.call('draft', {}, Draft))
    assert failure.value.details['error_type'] == 'TimeoutError'
    assert failure.value.details['response_bytes'] > 0
    assert failure.value.details['transport_phase'] == 'reading_body'
    assert client.events[-1]['status'] == 'failed'
    assert not list((tmp_path / 'checkpoints').glob('*.json'))


def test_gateway_timeout_has_concrete_message_and_bounded_retries(tmp_path):
    error = TrialError('http_error', http_status=524, fingerprint='request')
    assert '源站响应超时' in runtime.error_message(error)
    assert 'HTTP 524' in runtime.error_message(error)
    assert runtime.retry_delay(error, tmp_path) == 30
    assert runtime.retry_delay(error, tmp_path) == 60
    assert [runtime.retry_delay(error, tmp_path) for _ in range(3)] == [90, 120, 150]
    assert runtime.retry_delay(error, tmp_path) is None
    assert runtime.retry_delay(TrialError('provider_rejected', fingerprint='refusal'), tmp_path) is None


@pytest.mark.parametrize('model,gemini3', [('gemini-3-flash-preview',True),('假流式-gemini-3-flash-preview',True),('agy-gemini-3.8-flash-high',True),('other-model',False)])
def test_generation_limits_follow_model_family(tmp_path,monkeypatch,model,gemini3):
    bodies=[]
    async def send(self,body,event,stage):
        bodies.append(body)
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps({'blocks':[{'block_id':'p1','segments':[{'text':'回家','break_after':'none'}]}]})},'finish_reason':'stop'}]})
    monkeypatch.setattr(TrialClient,'send',send)
    client=TrialClient('https://example.test/v1','test-key',model,tmp_path)
    asyncio.run(client.call('draft',{},Draft))
    assert ('max_tokens' not in bodies[0]) == gemini3
    assert ('temperature' not in bodies[0]) == gemini3


@pytest.mark.parametrize('first_error',['invalid_json','schema_mismatch'])
def test_contract_correction_is_explicit_and_does_not_retranslate_finished_stages(tmp_path,monkeypatch,first_error):
    payloads=[]
    async def call(self,stage,payload,schema):
        payloads.append(payload)
        if len(payloads)==1:
            raise TrialError(first_error)
        return Draft(blocks=[])
    monkeypatch.setattr(TrialClient,'call',call)
    result=asyncio.run(make_client(tmp_path).call_with_contract_correction('draft',{'source':'sample'},Draft))
    assert result.blocks==[]
    assert len(payloads)==2 and 'response_contract_correction' not in payloads[0]
    assert payloads[1]['response_contract_correction']['allowed_top_level_fields']==['blocks']


@pytest.mark.parametrize('code,calls',[('invalid_json',3),('schema_mismatch',3),('provider_rejected',1),('authentication_failed',1),('truncated_output',1)])
def test_contract_correction_is_bounded_and_never_retries_refusals(tmp_path,monkeypatch,code,calls):
    requests=[]
    async def call(self,stage,payload,schema):
        requests.append(payload)
        raise TrialError(code)
    monkeypatch.setattr(TrialClient,'call',call)
    with pytest.raises(TrialError,match=code):
        asyncio.run(make_client(tmp_path).call_with_contract_correction('draft',{},Draft))
    assert len(requests)==calls
