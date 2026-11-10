"""V2 execution behind the existing authenticated task API and worker lease."""
from datetime import datetime, timezone
import json
import re
from pathlib import Path

from pydantic import Field
from sqlalchemy import select

from app.modules.translations.ai import platform_model_allowance
from app.modules.translations.source_text import fetch_source_chapter, SourceChapter
from app.modules.users.ai_settings import decrypt_ai_api_key
from app.modules.uploads.schemas import WorkSourceMetadata
from app.modules.books.models import BookRecord
from app.modules.book_assets.models import BookAssetRecord
from app.core.storage import get_storage_root, resolve_storage_path
from .pilot import SourceBlock, StrictModel, PROMPTS, COMMON, TrialError, digest, save_json, run_trial, plain, Draft
from .context import ContextPlan, merge_terms, context_revision, group_blocks, verified_context_plan
from .runtime import STAGES
from .whole_chapter import WholeChapterClient as StageClient, WHOLE_CHAPTER_PROMPTS
from .literary_policy import literary_contract, LITERARY_VERSION
from .publication import publish
from .control import Control
from .recovery import recover_failure


class Metadata(StrictModel):
    title: str = Field(min_length=1, max_length=255)
    author: str = Field(min_length=1, max_length=255)
    description: str
    tags: list[str]


PROMPTS['metadata'] = '仅汉化给出的作品标题、作者名、简介和标签。没有简介则返回空串，不创作简介；人名保留汉字或沿用规范译名。不要返回其他字段。'
STAGES['metadata'] = '正在翻译作品资料'




def snapshot(path: Path, value: dict):
    wrapped = {'value': value, 'hash': digest(value)}
    if path.exists():
        saved = json.loads(path.read_text(encoding='utf-8'))
        if saved != wrapped:
            raise TrialError('source_changed')
    else:
        save_json(path, wrapped)


def read_snapshot(path):
    saved = json.loads(path.read_text(encoding='utf-8'))
    if saved.get('hash') != digest(saved.get('value')):
        raise TrialError('source_snapshot_corrupt')
    return saved['value']


def first_name_annotation_positions(glossary, chapters, inherited_sources=()):
    """Only explicit glossary kana can be annotated, at its first source block.

    The model still determines whether the term is a person. Existing book terms
    are excluded on source updates, so later jobs cannot re-annotate old names.
    """
    pending = {t['source']: t for t in glossary if t['source'] not in inherited_sources
               and re.fullmatch(r'[\u3041-\u3096\u30a1-\u30faー・]+', t['source'])}
    positions = []
    for chapter in chapters:
        blocks = [(f'c{chapter.index}:title', chapter.title)] + [
            (f'c{chapter.index}:p{i+1}', text) for i, text in enumerate(chapter.paragraphs)]
        for block_id, text in blocks:
            for term in list(pending):
                if term in text:
                    positions.append({'source': term, 'target': pending.pop(term)['target'], 'block_id': block_id})
    return positions


async def execute(*, job_id, settings, session_factory, lease_owner=None):
    control = Control(job_id, lease_owner, session_factory, settings)
    job = control.read()
    if not job:
        return
    root = get_storage_root(settings) / 'translation-v2' / job.user_id / job.id
    def client(folder):
        parts = folder.split('/')
        chapter_work = parts[0] == 'units'
        scope = 'chapter:' + parts[1] if chapter_work else folder
        return StageClient(job.provider_base_url, decrypt_ai_api_key(job.provider_api_key_encrypted, settings),
            job.model, root / folder, guard=control.guard, report=control.report,
            capacity=max(1, min(16, control.read().request_concurrency or 1)),
            repair_retry_attempt=job.retry_count,
            budget_path=root / 'request-budget.sqlite3', budget_scope=scope,
            request_limit=(settings.translation_v2_chapter_request_limit if chapter_work
                           else settings.translation_v2_aux_request_limit),
            platform_settings=settings,
            model_daily_allowance=platform_model_allowance(
                job.model, settings, credential_key=decrypt_ai_api_key(job.provider_api_key_encrypted, settings)),
            lane_root=get_storage_root(settings) / 'translation-v2')
    try:
        root.mkdir(parents=True, exist_ok=True)
        control.guard()
        if job.job_kind == 'source_update' and (job.quality_report_json or {}).get('_v2_publication_approved'):
            # Acceptance approves these exact immutable paragraphs. Changing a
            # model or editing an earlier chapter must never silently retranslate
            # the prose that the user has already reviewed.
            candidate = read_snapshot(root / 'publication-candidate.json')
            expected = {(e['index'], e['url']) for e in job.catalog_json}
            actual = {(c['index'], c['source_url']) for c in candidate['chapters']}
            if actual != expected or len(candidate['chapters']) != len(expected):
                raise TrialError('source_changed')
            control.report('packaging', '正在验证并发布已确认的缓存译稿，不再请求翻译模型')
            publish(job_id=job_id, lease_owner=control.lease, chapters=candidate['chapters'],
                metadata=WorkSourceMetadata.model_validate(candidate['metadata']), settings=settings,
                session_factory=session_factory, guard=control.guard)
            return
        control.update(started_at=job.started_at or datetime.now(timezone.utc),
                       quality_report_json={**(job.quality_report_json or {}), '_workflow_version': 2,
                                            '_translation_policy': LITERARY_VERSION})
        metadata = WorkSourceMetadata.model_validate(job.metadata_json)
        if not metadata.episodes:
            raise TrialError('empty_source')
        control.total = len(metadata.episodes)
        source_chapters = []
        for position, episode in enumerate(metadata.episodes):
            control.position = position
            control.report('downloading', '正在保存原文快照')
            path = root / 'source' / f'{position+1:05d}.json'
            if path.exists():
                values = read_snapshot(path)
                if values['url'] != episode.url:
                    raise TrialError('source_changed')
                chapter = SourceChapter(**values)
            else:
                chapter = await fetch_source_chapter(episode, metadata.source, flaresolverr_url=settings.flaresolverr_url)
                control.guard()
                snapshot(path, chapter.__dict__)
            if not chapter.paragraphs or any(not p.strip() or '\ufffd' in p for p in chapter.paragraphs):
                raise TrialError('invalid_source_text', chapter=chapter.index)
            source_chapters.append(chapter)
        # Existing user-edited Chinese prose is reference, never overwritten by
        # project memory. Restrict it to the prior reading position.
        existing_reference = ''
        inherited_glossary = []
        if job.job_kind == 'source_update':
            with session_factory() as session:
                book = session.get(BookRecord, job.book_id)
                if not book or book.owner_id != job.user_id or book.deleted_at:
                    raise TrialError('publication_conflict')
                if book.original_file_path:
                    context_file = resolve_storage_path(get_storage_root(settings), book.original_file_path).parent / 'translation-context.json'
                    if context_file.is_file():
                        inherited_glossary = read_snapshot(context_file)['glossary']
                refs = list(session.scalars(select(BookAssetRecord).where(
                    BookAssetRecord.book_id == book.id, BookAssetRecord.asset_type == 'text_chapter'
                ).order_by(BookAssetRecord.index.desc()).limit(2)))
                existing_reference = '\n'.join(resolve_storage_path(get_storage_root(settings), a.path).read_text(
                    encoding='utf-8') for a in reversed(refs))[-12000:]
        # Do not rerun a raw cache under a different source/channel/prompt or
        # context: these inputs all participate in the stage fingerprints.
        translated_metadata = metadata
        if job.job_kind != 'source_update':
            control.position = 0
            meta = await client('metadata').call('metadata', {
                'title': metadata.title, 'author': metadata.author,
                'description': metadata.description, 'tags': metadata.tags}, Metadata)
            translated_metadata = metadata.model_copy(update=meta.model_dump())
            control.update(title=meta.title, author=meta.author,
                           translated_metadata_json=translated_metadata.model_dump(mode='json'))
        glossary, plans, proposal_conflicts = inherited_glossary, [], []
        planning_fingerprint = digest({'source': [c.__dict__ for c in source_chapters],
            'reference': existing_reference, 'inherited_glossary': inherited_glossary, 'preferences': job.custom_instructions,
            'prompt': COMMON + PROMPTS['context'], 'schema': ContextPlan.model_json_schema()})
        planning_path = root / 'planning' / (planning_fingerprint + '.json')
        saved_planning = read_snapshot(planning_path) if planning_path.exists() else None
        # A full-source planning pass, not chapter-head sampling. Only terminology
        # is shared forward; future plot summaries stay out of earlier chapters.
        for position, chapter in enumerate(source_chapters):
            if saved_planning:
                break
            control.position = position
            blocks = [SourceBlock(block_id=f'c{chapter.index}:title', text=chapter.title)] + [
                SourceBlock(block_id=f'c{chapter.index}:p{i+1}', text=p) for i, p in enumerate(chapter.paragraphs)]
            groups = group_blocks(blocks)
            chapter_plans = []
            control.unit_total = len(groups)
            for unit, group in enumerate(groups):
                control.unit_position = unit
                plan = await verified_context_plan(client(f'context/{position+1:05d}/{unit:04d}'), {
                    'source_blocks': [b.model_dump() for b in group], 'glossary': glossary,
                    'existing_zh_reference': existing_reference}, group, diagnostics=proposal_conflicts)
                glossary = merge_terms(glossary, plan, group, proposal_conflicts=proposal_conflicts)
                chapter_plans.append(plan.model_dump())
            plans.append({'groups': groups, 'plans': chapter_plans})
        if saved_planning:
            glossary = saved_planning['glossary']
            proposal_conflicts = saved_planning.get('proposal_conflicts', [])
            plans = [{'groups': [[SourceBlock.model_validate(b) for b in group] for group in p['groups']],
                      'plans': p['plans']} for p in saved_planning['plans']]
        else:
            snapshot(planning_path, {'glossary': glossary, 'proposal_conflicts': proposal_conflicts, 'plans': [
                {'groups': [[b.model_dump() for b in group] for group in p['groups']], 'plans': p['plans']}
                for p in plans]})
        save_json(root / 'glossary.json', {'glossary': glossary, 'hash': digest(glossary),
            'approval': 'system_selected', 'discarded_proposals': proposal_conflicts})
        prior_summary, prior_tail, translated = '', [], []
        annotation_positions = first_name_annotation_positions(glossary, source_chapters,
            {t['source'] for t in inherited_glossary})
        reports = {'_workflow_version': 2, '_translation_policy': LITERARY_VERSION,
                   '_v2_publication_approved': bool((job.quality_report_json or {}).get('_v2_publication_approved'))}
        if (job.quality_report_json or {}).get('_publication'):
            reports['_publication'] = job.quality_report_json['_publication']

        def publish_readable_prefix():
            if job.job_kind != 'whole_book' or not translated:
                return
            control.guard()
            publish(job_id=job_id, lease_owner=control.lease, chapters=translated,
                    metadata=translated_metadata, settings=settings, session_factory=session_factory,
                    guard=control.guard, finalize=False)
            reports['_publication'] = control.read().quality_report_json['_publication']

        for position, (chapter, planned) in enumerate(zip(source_chapters, plans, strict=True)):
            control.position = position
            control.update(current_chapter_index=chapter.index)
            completed_input = {'planning': planning_fingerprint, 'glossary': glossary,
                'source': chapter.__dict__, 'prior_summary': prior_summary, 'prior_tail': prior_tail,
                'prompts': COMMON + json.dumps(PROMPTS, ensure_ascii=False, sort_keys=True)}
            legacy_path = root / 'completed' / (digest(completed_input) + '.json')
            whole_chapter_key = digest({**completed_input, 'generation_mode': 'whole-chapter-v1',
                                       'stage_prompts': WHOLE_CHAPTER_PROMPTS})
            completed_key = digest({**completed_input, 'generation_mode': LITERARY_VERSION,
                                    'literary_contract': literary_contract()})
            checkpoint_path = root / 'completed' / (completed_key + '.json')
            # Keep already-approved legacy chapters without treating unfinished
            # old shards as proof that the new whole-chapter stages completed.
            if not checkpoint_path.exists():
                for approved_path in (root / 'completed' / (whole_chapter_key + '.json'), legacy_path):
                    if approved_path.exists():
                        checkpoint_path = approved_path
                        break
            if checkpoint_path.exists():
                cached = read_snapshot(checkpoint_path)
                completed = cached['chapter']
                if completed['source_hash'] != digest(chapter.__dict__) or len(completed['paragraphs']) != len(chapter.paragraphs):
                    raise TrialError('checkpoint_corrupt')
                translated.append(completed)
                prior_summary, prior_tail = cached['prior_summary'], cached['prior_tail']
                reports[str(chapter.index)] = cached['qa']
                control.update(completed_chapters=max(job.completed_chapters or 0, position+1), quality_report_json=reports,
                               message=f'V2 · 已恢复通过检查的第 {position+1}/{control.total} 话')
                continue
            # Publish a recovered prefix together before requesting any new
            # chapter. Existing jobs become readable without retranslation.
            publish_readable_prefix()
            output, unit_reports = [], []
            # Old planning checkpoints can contain 120-paragraph partitions.
            # Reunite only unfinished chapters; preserve completed checkpoints.
            if len(planned['groups']) > 1:
                planned = {'groups': [[b for g in planned['groups'] for b in g]], 'plans': [{
                    'summary': '\n'.join(p['summary'] for p in planned['plans']),
                    'voice_notes': [v for p in planned['plans'] for v in p['voice_notes']],
                    'uncertainties': [v for p in planned['plans'] for v in p.get('uncertainties', [])]}]}
            control.unit_total = len(planned['groups'])
            for unit, group in enumerate(planned['groups']):
                control.unit_position = unit
                context = context_revision(glossary, prior_summary, prior_tail)
                context.update(existing_zh_reference=existing_reference, preferences=job.custom_instructions or '',
                               voice_notes=planned['plans'][unit]['voice_notes'],
                               uncertainties=planned['plans'][unit].get('uncertainties', []),
                               prior_voice_notes=[{'chapter': source_chapters[i].index,
                                   'notes': [v for p in plans[i]['plans'] for v in p['voice_notes']]}
                                   for i in range(max(0, position-3), position)],
                               name_annotations=[a for a in annotation_positions
                                   if a['block_id'] in {b.block_id for b in group}],
                               translation_policy=LITERARY_VERSION)
                result = await run_trial(client(f'units/{position+1:05d}/{unit:04d}'), group, context=context)
                unit_reports.append({'source_hash': result['source_hash'], 'target_hash': result['target_hash'],
                    'review': result['review'], 'remaining': result['deterministic_findings'], 'status': result['status']})
                if result['status'] != 'trial_checks_completed':
                    save_json(root / 'quality-blocked.json', {'chapter': chapter.index, 'unit': unit, 'result': result})
                    issues = [f for f in result['deterministic_findings'] + result['review']['findings']
                              if f.get('severity') != 'minor']
                    raise TrialError('quality_blocked', block_id=f'c{chapter.index}/u{unit}',
                                     issues=[{'block_id': f['block_id'], 'code': f['code']} for f in issues])
                candidate = Draft.model_validate(result['draft'])
                output.extend(candidate.blocks)
                prior_tail = [b.model_dump() for b in candidate.blocks[-4:]]
                prior_summary = planned['plans'][unit]['summary']
            control.guard()
            completed = {'index': chapter.index, 'source_url': chapter.url, 'source_title': chapter.title,
                'title': plain(output[0]).strip(), 'paragraphs': [plain(b).strip() for b in output[1:]],
                'source_hash': digest(chapter.__dict__)}
            if len(completed['paragraphs']) != len(chapter.paragraphs):
                raise TrialError('chapter_coverage_mismatch')
            save_json(root / 'translated' / f'{position+1:05d}.json', completed)
            translated.append(completed)
            reports[str(chapter.index)] = {'units': unit_reports, 'status': 'completed'}
            snapshot(checkpoint_path, {'chapter': completed, 'qa': reports[str(chapter.index)],
                'prior_summary': prior_summary, 'prior_tail': prior_tail, 'model': job.model})
            control.update(completed_chapters=position+1, quality_report_json=reports,
                           memory_json={'_workflow_version': 2, 'glossary': glossary},
                           message=f'V2 · 已完成质检 {position+1}/{control.total} 话，尚未发布')
            publish_readable_prefix()
        # Manual-update preference must survive the engine replacement. A user
        # confirmation queues publication of these same immutable checkpoints.
        control.update(memory_json={'_workflow_version': 2, 'glossary': glossary})
        snapshot(root / 'publication-candidate.json', {'chapters': translated,
            'metadata': translated_metadata.model_dump(mode='json')})
        if job.job_kind == 'source_update':
            # Automatic detection authorizes translation, never publication.
            if not reports['_v2_publication_approved']:
                control.update(status='review', stage='review', progress=90,
                    message=f'{len(translated)} 话更新译稿已完成，请查看并决定是否接受；原书尚未修改',
                    error_message=None, acknowledged=False, lease_owner=None, lease_expires_at=None,
                    finished_at=datetime.now(timezone.utc))
                return
        control.report('packaging', '正在验证 EPUB 和在线阅读资源')
        publish(job_id=job_id, lease_owner=control.lease, chapters=translated, metadata=translated_metadata,
                settings=settings, session_factory=session_factory, guard=control.guard)
    except Exception as error:
        recover_failure(error, root=root, control=control, settings=settings, save=save_json)
