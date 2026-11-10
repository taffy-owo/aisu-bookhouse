from dataclasses import replace
from datetime import datetime,timedelta,timezone
from uuid import uuid4

import pytest

from app.core.config import Settings
from app.modules.reader_marks.domain import ReaderMark
from app.modules.reader_marks.repository import InMemoryReaderMarkRepository,SqlAlchemyReaderMarkRepository
from test_reader import make_epub_with_documents


def upload(client,headers,extension='epub'):
    documents=[('第1章 起点','甲'*100),('第2章 途中','乙'*1600),('第3章 归途','丙'*100)]
    data=make_epub_with_documents(documents) if extension=='epub' else '\n\n'.join(f'{title}\n\n{body}' for title,body in documents).encode()
    response=client.post('/api/v1/uploads/books',headers=headers,files={'file':('catalog.'+extension,data,'application/epub+zip' if extension=='epub' else 'text/plain')})
    assert response.status_code==200,response.text
    return response.json()['book_id']


def reader(client,headers,bid):
    response=client.get(f'/api/v1/books/{bid}/reader',headers=headers)
    assert response.status_code==200,response.text
    return response.json()


@pytest.mark.parametrize('title',['目录','封面','插图'])
def test_explicit_epub_edit_keeps_chapter_and_resume_even_after_reprocess(client,auth_headers,title):
    bid=upload(client,auth_headers)
    initial=reader(client,auth_headers,bid)
    key=initial['toc'][2]['position_key']
    saved=client.put(f'/api/v1/books/{bid}/progress',headers=auth_headers,json={'reader_type':'epub','chapter_index':3,'position_key':key,'epub_cfi':'aisu-scroll:0.5','progress_percent':97,'updated_at':(datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat()})
    assert saved.status_code==200,saved.text
    response=client.put(f'/api/v1/books/{bid}/chapters/2',headers=auth_headers,json={'title':title,'content':'修订正文。'*300})
    assert response.status_code==200,response.text
    for reprocess in [False,True]:
        if reprocess:
            result=client.post(f'/api/v1/uploads/books/{bid}/reprocess',headers=auth_headers)
            assert result.status_code==200,result.text
        resource=reader(client,auth_headers,bid)
        assert resource['chapter_count']==3,resource
        assert resource['toc'][1]['title']==title
        if not reprocess:
            assert resource['toc'][2]['position_key']==key
        current_key=resource['toc'][2]['position_key']
        editable=client.get(f'/api/v1/books/{bid}/chapters/2/edit',headers=auth_headers)
        assert editable.status_code==200 and editable.json()['title']==title
        assert editable.json()['content']=='修订正文。'*300
        startup=client.get(f'/api/v1/books/{bid}/reader/startup',headers=auth_headers)
        assert startup.status_code==200,startup.text
        assert startup.json()['chapter']['position_key']==current_key
        assert startup.json()['progress']['chapter_index']==3


@pytest.mark.parametrize('extension',['epub','txt'])
def test_explicit_append_named_like_front_matter_stays_readable(client,auth_headers,extension):
    bid=upload(client,auth_headers,extension)
    response=client.post(f'/api/v1/books/{bid}/chapters',headers=auth_headers,json={'title':'目录','content':'这是一话有意使用特殊标题的正文。'})
    assert response.status_code==200,response.text
    resource=reader(client,auth_headers,bid)
    assert resource['chapter_count']==response.json()['chapter_count']==4
    assert resource['toc'][-1]['title']=='目录'
    chapter=client.get(f'/api/v1/books/{bid}/reader/chapters/4',headers=auth_headers)
    assert chapter.status_code==200 and chapter.json()['content']=='这是一话有意使用特殊标题的正文。'


def test_txt_arbitrary_title_edit_keeps_original_file_chapter_boundaries(client,auth_headers):
    bid=upload(client,auth_headers,'txt')
    response=client.put(f'/api/v1/books/{bid}/chapters/2',headers=auth_headers,json={'title':'雨后的来信','content':'修订后的正文。'})
    assert response.status_code==200,response.text
    response=client.post(f'/api/v1/uploads/books/{bid}/reprocess',headers=auth_headers)
    assert response.status_code==200,response.text
    resource=reader(client,auth_headers,bid)
    assert resource['chapter_count']==3,resource
    chapter=client.get(f'/api/v1/books/{bid}/reader/chapters/2',headers=auth_headers).json()
    assert '雨后的来信' in chapter['title']
    assert chapter['content']=='修订后的正文。'


def create_mark(client,headers,bid):
    resource=reader(client,headers,bid)
    response=client.post(f'/api/v1/books/{bid}/marks',headers=headers,json={'reader_type':'epub','kind':'note','label':'手写标题','note':'第一行\n第二行','chapter_index':2,'position_key':resource['toc'][1]['position_key'],'epub_cfi':'aisu-scroll:0.75','progress_percent':72})
    assert response.status_code==201,response.text
    return response.json()


@pytest.mark.parametrize('operation',['append','edit','delete'])
def test_marks_show_current_weighted_percentage_without_editing_note_time(client,auth_headers,operation):
    bid=upload(client,auth_headers)
    mark=create_mark(client,auth_headers,bid)
    if operation=='append':
        result=client.post(f'/api/v1/books/{bid}/chapters',headers=auth_headers,json={'title':'第4章 新篇','content':'丁'*800})
    elif operation=='edit':
        result=client.put(f'/api/v1/books/{bid}/chapters/1',headers=auth_headers,json={'title':'第1章 起点','content':'甲'*1000})
    else:
        result=client.delete(f'/api/v1/books/{bid}/chapters/1',headers=auth_headers)
    assert result.status_code==200,result.text
    resource=reader(client,auth_headers,bid)
    toc=resource['toc'];index=next(i for i,item in enumerate(toc,1) if item['position_key']==mark['position_key'])
    weights=[item['progress_weight'] for item in toc]
    calculated=int((sum(weights[:index-1])+weights[index-1]*.75)/sum(weights)*100+.5)
    # The fixture has deliberately uneven chapter lengths; the server returns
    # authoritative weights, which can include the original chapter headings.
    assert calculated>0
    for endpoint in [f'/api/v1/books/{bid}/marks',f'/api/v1/books/{bid}/reader/startup']:
        response=client.get(endpoint,headers=auth_headers)
        assert response.status_code==200,response.text
        shown=(response.json() if endpoint.endswith('/marks') else response.json()['marks'])[0]
        assert shown['progress_percent']==calculated
        assert shown['chapter_index']==index
        for field in ['note','label','created_at','updated_at','epub_cfi','position_key']:
            assert shown[field]==mark[field]
    edited=client.patch(f"/api/v1/books/{bid}/marks/{mark['id']}",headers=auth_headers,json={'note':'修改后的备注'})
    assert edited.status_code==200 and edited.json()['progress_percent']==calculated


def test_deleting_marked_chapter_preserves_note_and_edit_time(client,auth_headers):
    bid=upload(client,auth_headers)
    mark=create_mark(client,auth_headers,bid)
    assert client.delete(f'/api/v1/books/{bid}/chapters/2',headers=auth_headers).status_code==200
    shown=client.get(f'/api/v1/books/{bid}/marks',headers=auth_headers).json()[0]
    assert shown['position_valid'] is False
    for field in ['note','label','created_at','updated_at','epub_cfi','position_key']:
        assert shown[field]==mark[field]


def test_txt_repeated_renames_do_not_leave_an_old_heading_in_neighbor_content(client,auth_headers):
    bid=upload(client,auth_headers,'txt')
    for title in ['雨后的来信','第2章 新的标题','雪夜']:
        response=client.put(f'/api/v1/books/{bid}/chapters/2',headers=auth_headers,json={'title':title,'content':'最后保留的正文。'})
        assert response.status_code==200,response.text
    assert client.post(f'/api/v1/uploads/books/{bid}/reprocess',headers=auth_headers).status_code==200
    resource=reader(client,auth_headers,bid)
    assert resource['chapter_count']==3
    for index,body in [(1,'甲'*100),(2,'最后保留的正文。'),(3,'丙'*100)]:
        chapter=client.get(f'/api/v1/books/{bid}/reader/chapters/{index}',headers=auth_headers).json()
        assert chapter['content']==body
    original=client.get(f'/api/v1/files/books/{bid}/original',headers=auth_headers).content.decode()
    assert '雨后的来信' not in original and '第2章 新的标题' not in original


def test_real_imported_front_matter_stays_hidden_when_neighbor_is_edited(client,auth_headers):
    response=client.post('/api/v1/uploads/books',headers=auth_headers,files={'file':('front.epub',make_epub_with_documents([('目录','这是原书目录。'),('第一章','原书正文。'),('第二章','邻话正文。')]),'application/epub+zip')})
    assert response.status_code==200,response.text
    bid=response.json()['book_id']
    assert reader(client,auth_headers,bid)['chapter_count']==2
    assert client.put(f'/api/v1/books/{bid}/chapters/1',headers=auth_headers,json={'title':'目录','content':'有意如此命名的正文。'}).status_code==200
    for reprocess in [False,True]:
        if reprocess:assert client.post(f'/api/v1/uploads/books/{bid}/reprocess',headers=auth_headers).status_code==200
        resource=reader(client,auth_headers,bid)
        assert [item['title'] for item in resource['toc']]==['目录','第二章']
        assert client.get(f'/api/v1/books/{bid}/reader/chapters/1',headers=auth_headers).json()['content']=='有意如此命名的正文。'


def test_listing_reweighted_marks_is_read_only_and_old_formats_are_untouched(client,auth_headers):
    bid=upload(client,auth_headers)
    mark=create_mark(client,auth_headers,bid)
    with client.app.state.db_session_factory() as session:
        repository=SqlAlchemyReaderMarkRepository(session)
        original=repository.get(Settings.default_user_id,mark['id'])
        old_format=replace(original,id=str(uuid4()),reader_type='comic')
        repository.save(old_format)
    assert client.delete(f'/api/v1/books/{bid}/chapters/1',headers=auth_headers).status_code==200
    with client.app.state.db_session_factory() as session:
        repository=SqlAlchemyReaderMarkRepository(session)
        rebased=repository.get(original.user_id,original.id)
        assert rebased==replace(original,chapter_index=1)
        assert repository.get(old_format.user_id,old_format.id)==old_format
    for _ in range(2):
        assert client.get(f'/api/v1/books/{bid}/marks',headers=auth_headers).status_code==200
        assert client.get(f'/api/v1/books/{bid}/reader/startup',headers=auth_headers).status_code==200
    with client.app.state.db_session_factory() as session:
        repository=SqlAlchemyReaderMarkRepository(session)
        assert repository.get(original.user_id,original.id)==rebased
        assert repository.get(old_format.user_id,old_format.id)==old_format


@pytest.mark.parametrize('storage',['memory','sql'])
@pytest.mark.parametrize('newer_action',['note','relocation','deletion'])
def test_catalog_position_rebase_preserves_newer_note_or_deletion(client,storage,newer_action):
    at=datetime.now(timezone.utc)+timedelta(minutes=1)
    original=ReaderMark(id=str(uuid4()),user_id=Settings.default_user_id,book_id='b1',reader_type='epub',kind='note',
        note='原备注',label='手写标题',progress_percent=50,chapter_index=2,epub_cfi='aisu-scroll:0.5',created_at=at,updated_at=at)
    with client.app.state.db_session_factory() as session:
        repository=InMemoryReaderMarkRepository() if storage=='memory' else SqlAlchemyReaderMarkRepository(session)
        repository.save(original)
        rebased=replace(original,chapter_index=1)
        repository.rebase_position(original,rebased)
        assert repository.get(original.user_id,original.id)==rebased
        if newer_action=='deletion':
            assert repository.delete(original.user_id,original.id)
            expected=None
        else:
            expected=replace(rebased,updated_at=at+timedelta(seconds=1),**({'note':'新的备注'} if newer_action=='note' else {'chapter_index':3}))
            repository.save(expected)
        repository.rebase_position(rebased,replace(rebased,position_valid=False))
        assert repository.get(original.user_id,original.id)==expected


def test_failed_deletion_preserves_entire_mark_and_time(client,auth_headers,monkeypatch):
    from sqlalchemy.orm import Session
    from app.modules.auth.models import ApiRequestRecord
    bid=upload(client,auth_headers)
    mark=create_mark(client,auth_headers,bid)
    native_commit=Session.commit
    def fail_publication(session):
        if any(isinstance(record,ApiRequestRecord) for record in session.new):raise RuntimeError('catalog publication failed')
        return native_commit(session)
    monkeypatch.setattr(Session,'commit',fail_publication)
    with pytest.raises(RuntimeError,match='catalog publication failed'):
        client.delete(f'/api/v1/books/{bid}/chapters/2',headers=auth_headers)
    assert reader(client,auth_headers,bid)['chapter_count']==3
    assert client.get(f'/api/v1/books/{bid}/marks',headers=auth_headers).json()==[mark]
