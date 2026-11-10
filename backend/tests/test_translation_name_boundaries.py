from dataclasses import replace

import pytest
from app.core.config import Settings
from app.modules.translations import service
from app.modules.translations.models import WholeBookTranslationJobRecord

MEMORY = {'glossary':[
    {'source':'シャルロット','target':'夏洛特','kind':'character','locked':True},
    {'source':'シャル','target':'夏露','kind':'character','locked':True},
]}


@pytest.mark.parametrize('source,target',[
    ('シャルロットは図書館へ行った。','夏洛特去了图书馆。'),
    ('「シャルロット！」','「夏洛特！」'),
    ('シャルさん。','夏露。'),
    ('「シャルー！」','「夏露——！」'),
    ('シャルロットとシャル。','夏洛特与夏露。'),
])
def test_full_name_and_nickname_are_not_substrings(source,target):
    assert not service._deterministic_quality_issues([source],[target],MEMORY)


@pytest.mark.parametrize('source,target',[
    ('シャルロットは笑った。','夏露笑了。'),
    ('シャルは笑った。','夏洛特笑了。'),
    ('シャルロットとシャル。','夏洛特与夏洛特。'),
])
def test_real_name_drift_is_still_a_hard_failure(source,target):
    assert any(i.severity=='hard' for i in service._deterministic_quality_issues([source],[target],MEMORY))


def test_unknown_longer_katakana_name_does_not_trigger_short_name():
    assert service._glossary_sources_in_text('シャルロット',('シャル',)) == set()
    assert service._glossary_sources_in_text('Anna and Ann',('Ann','Anna')) == {'Anna','Ann'}
    assert service._glossary_sources_in_text('Annabelle',('Ann',)) == set()


def test_all_locked_terms_survive_compact_memory_and_are_checked_beyond_100():
    memory = {'glossary':[{'source':f'Person{i}','target':f'人名{i}','locked':True,'kind':'character'} for i in range(200)]}
    settings = replace(Settings(),ai_translation_chunk_characters=1000)
    compact = service.translation_request_memory(memory,settings)
    assert len(compact['glossary']) == 200
    assert service._deterministic_quality_issues(['Person199。'],['译错了。'],memory)[0].severity == 'hard'


def test_initial_memory_does_not_discard_locked_terms_at_size_limit():
    entries = [{'source':f'Name{i}','target':f'人名{i}','locked':True,'kind':'character','note':'x'*500} for i in range(150)]
    memory = service._coerce_memory({'glossary':entries})
    assert len(memory['glossary']) == 150


@pytest.mark.parametrize('completed',[0,1])
def test_failed_quality_is_never_reported_passed(completed):
    record = WholeBookTranslationJobRecord(status='failed',completed_chapters=completed,
        error_message='第 2 话质检不通过：第 24 段错误；第 59 段错误',quality_report_json={'1':{'chunks':[]}},memory_json={})
    assert service._translation_quality_summary(record) == ('warning',2)


@pytest.mark.asyncio
async def test_false_nickname_alarm_never_calls_repair_model(monkeypatch):
    async def forbidden(**kwargs):
        pytest.fail('A valid full name must not trigger a repair call')
    monkeypatch.setattr(service,'_request_translation_list',forbidden)
    chapter = service.SourceChapter(index=2,title='测试',url='https://example.invalid/2',paragraphs=['シャルロットは図書館へ行った。'])
    output,issues,attempts,_ = await service._repair_hard_quality_paragraphs(chapter=chapter,
        source=chapter.paragraphs,translated=['夏洛特去了图书馆。'],memory=MEMORY,settings=Settings(),translation_preferences='')
    assert output == ['夏洛特去了图书馆。'] and issues == [] and attempts == 0
