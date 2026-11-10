"""Evidence-bound, append-only terminology; planning is not narrative context."""
from pydantic import Field

from .pilot import StrictModel, SourceBlock, TrialError, digest


class Term(StrictModel):
    source: str = Field(min_length=1, max_length=100)
    target: str = Field(min_length=1, max_length=100)
    evidence_block_id: str
    evidence_quote: str = Field(min_length=1)
    note: str = Field(max_length=500)


class ContextPlan(StrictModel):
    checked_block_ids: list[str]
    terms: list[Term]
    summary: str = Field(max_length=2200)
    voice_notes: list[str]
    uncertainties: list[str]


CONTEXT_PROMPT = '''读取本单元的全部原文，规划专名、人物称呼及语气。
输出 checked_block_ids 必须按输入顺序覆盖全部块；只为有明确来源证据的名字/设定词建立 terms。
现有 glossary 的译名已锁定，不得改写；同名异人或普通词与专名歧义写入 uncertainties，不要强行合并。
新术语必须提供原文实际出现的 evidence_block_id/evidence_quote，source 必须包含在该引文中。
summary 简述本单元实际发生的事实；不脑补身份、性别、关系或未揭示的真相。
voice_notes 只记录有依据的说话方式。此处分析不是正文，后续翻译不能提前揭露规划资料。'''


def merge_terms(current: list[dict], plan: ContextPlan, blocks: list[SourceBlock],
                *, proposal_conflicts: list[dict] | None = None) -> list[dict]:
    if plan.checked_block_ids != [b.block_id for b in blocks]:
        raise TrialError('context_coverage_mismatch')
    sources = {b.block_id: b.text for b in blocks}
    merged = {t['source']: dict(t) for t in current}
    for term in plan.terms:
        evidence = sources.get(term.evidence_block_id, '')
        if term.evidence_quote not in evidence or term.source not in term.evidence_quote:
            raise TrialError('term_evidence_invalid', block_id=term.evidence_block_id)
        prior = merged.get(term.source)
        if prior and prior['target'] != term.target:
            if proposal_conflicts is not None:
                # A pre-reading suggestion is not a committed translation.
                # Retain the locked value; do not mechanically replace prose or
                # stop the book merely because a model proposed another spelling.
                proposal_conflicts.append({'source': term.source, 'kept': prior['target'],
                    'proposed': term.target, 'block_id': term.evidence_block_id})
                continue
            raise TrialError('term_conflict', block_id=term.evidence_block_id,
                             source=term.source, expected=prior['target'], received=term.target)
        if not prior:
            merged[term.source] = term.model_dump()
    return list(merged.values())


def context_revision(glossary: list[dict], prior_summary: str, prior_tail: list[dict]) -> dict:
    value = {'glossary': glossary, 'prior_summary': prior_summary, 'prior_tail': prior_tail}
    return {**value, 'revision': digest(value)}


def group_blocks(blocks: list[SourceBlock], *, max_characters: int | None = None, max_blocks: int | None = None) -> list[list[SourceBlock]]:
    """Never break or merge paragraphs to satisfy a token estimate."""
    groups, group, count = [], [], 0
    for block in blocks:
        if group and ((max_characters is not None and count + len(block.text) > max_characters)
                      or (max_blocks is not None and len(group) >= max_blocks)):
            groups.append(group)
            group, count = [], 0
        group.append(block)
        count += len(block.text)
    if group:
        groups.append(group)
    return groups


async def verified_context_plan(client, payload, blocks, *, diagnostics):
    """Evidence corrections never promote an unsupported term to the glossary.

    A speculative invalid term is not a corrupt chapter. After two explicit
    corrections quarantine only unsupported proposals; retain actual full
    reading coverage and valid names. Never invent a missing checked ID.
    """
    shaped = payload
    expected = [b.block_id for b in blocks]
    sources = {b.block_id: b.text for b in blocks}
    for attempt in range(3):
        plan = await client.call('context', shaped, ContextPlan)
        actual = plan.checked_block_ids
        coverage = len(set(actual)) == len(actual) and set(actual) == set(expected)
        valid, invalid = [], []
        for term in plan.terms:
            evidence = sources.get(term.evidence_block_id, '')
            if term.evidence_quote in evidence and term.source in term.evidence_quote:
                valid.append(term)
                continue
            matches = [key for key,text in sources.items() if term.evidence_quote in text and term.source in term.evidence_quote]
            if len(matches) == 1:
                valid.append(term.model_copy(update={'evidence_block_id': matches[0]}))
                diagnostics.append({'source': term.source, 'code': 'term_evidence_reanchored', 'block_id': matches[0]})
            else:
                invalid.append(term)
        if coverage and (not invalid or attempt == 2):
            diagnostics.extend({'source': t.source, 'proposed': t.target, 'block_id': t.evidence_block_id,
                'code': 'unsupported_term_not_adopted'} for t in invalid)
            return plan.model_copy(update={'checked_block_ids': expected, 'terms': valid,
                'uncertainties': plan.uncertainties + [f'未采纳缺少原文证据的术语候选：{t.source}' for t in invalid]})
        if attempt == 2:
            raise TrialError('context_coverage_mismatch', stage='context', expected=len(expected), received=len(actual))
        shaped = {**payload, 'context_validation_feedback': {'attempt': attempt+1,
            'required_ids': expected, 'invalid_terms': [t.model_dump() for t in invalid],
            'instruction': '重新核对整话原文并返回完整规划。术语 source 必须逐字存在于该编号的引文中，不能用近义词代替。普通代词、泛称无需锁为专名，无证据候选请删除。checked_block_ids 必须覆盖整话全部原段落。'}}
