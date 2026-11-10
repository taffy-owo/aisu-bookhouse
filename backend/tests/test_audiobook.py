import asyncio
import base64
from io import BytesIO
import json
import re
import wave

import httpx
import pytest
from fastapi.testclient import TestClient

import app.modules.files.api as files_api
import app.modules.reader.api as reader_api
import app.modules.reader.audiobook as audiobook_module
from app.core.config import Settings
from app.modules.books.service import get_book_storage_directories
from app.modules.reader.audiobook import (
    AUDIOBOOK_PAUSE_MILLISECONDS,
    AUDIOBOOK_PCM_SAMPLE_RATE,
    ChapterAudiobook,
    build_edge_tts_timeline,
    build_estimated_timeline,
    build_segment_timeline,
    build_wav_header,
    combine_wav_chunks,
    choose_default_edge_voice,
    normalize_audiobook_text,
    parse_tts_wav_response,
    request_tts_wav,
    split_audiobook_segments,
    split_audiobook_text,
    stream_chapter_audiobook,
    stream_tts_pcm,
)


def make_wav_bytes(*, frame_count: int = 120, frame_rate: int = 8_000) -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(frame_rate)
        audio.writeframes(b"\x00\x00" * frame_count)
    return output.getvalue()


def test_normalizes_and_splits_audiobook_text_without_losing_content() -> None:
    text = "  First sentence.\r\n\r\n" + "Second sentence! " * 30 + "\u200b"

    normalized = normalize_audiobook_text(text)
    chunks = split_audiobook_text(normalized, max_chars=80)

    assert normalized.startswith("First sentence.\n\nSecond sentence!")
    assert all(0 < len(chunk) <= 80 for chunk in chunks)
    assert re.sub(r"\s+", "", "".join(chunks)) == re.sub(r"\s+", "", normalized)


def test_audiobook_segments_preserve_source_paragraph_indexes() -> None:
    segments = split_audiobook_segments("第一段很长。继续。\n\n第二段。", max_chars=7)

    assert [part.paragraph_index for segment in segments for part in segment.parts] == [0, 0, 1]
    assert "".join(part.text for segment in segments for part in segment.parts) == "第一段很长。继续。第二段。"


def test_segment_timeline_uses_measured_pcm_duration_and_pause() -> None:
    segments = split_audiobook_segments("短段。\n\n这是更长的第二段。", max_chars=100)
    one_second_pcm = AUDIOBOOK_PCM_SAMPLE_RATE * 2
    timeline = build_segment_timeline(segments, [one_second_pcm])

    assert timeline["ready"] is True
    assert timeline["duration_seconds"] == pytest.approx(1.0)
    assert [cue["paragraph_index"] for cue in timeline["cues"]] == [0, 1]
    assert timeline["cues"][0]["start_seconds"] == 0
    assert timeline["cues"][-1]["end_seconds"] == pytest.approx(1.0)


def test_estimated_timeline_has_ordered_paragraph_cues() -> None:
    timeline = build_estimated_timeline("第一段。\n\n第二段更长一些。", 12.0, ready=False)

    assert timeline["ready"] is False
    assert timeline["duration_seconds"] == 12.0
    assert [cue["paragraph_index"] for cue in timeline["cues"]] == [0, 1]
    assert timeline["cues"][0]["start_seconds"] == 0
    assert timeline["cues"][0]["end_seconds"] == timeline["cues"][1]["start_seconds"]
    assert timeline["cues"][1]["end_seconds"] == 12.0


def test_default_voice_matches_chinese_and_japanese_text() -> None:
    assert choose_default_edge_voice("她轻轻笑了。\n\n今天也要继续前进。") == "zh-CN-XiaoxiaoNeural"
    assert choose_default_edge_voice("彼女は笑った。\n\n今日も進みます。") == "ja-JP-NanamiNeural"


def test_edge_sentence_boundaries_build_a_contiguous_paragraph_timeline() -> None:
    timeline = build_edge_tts_timeline(
        "第一段。\n\n第二段。",
        [
            {"type": "SentenceBoundary", "offset": 0, "duration": 10_000_000, "text": "第一段。"},
            {"type": "SentenceBoundary", "offset": 10_000_000, "duration": 20_000_000, "text": "第二段。"},
        ],
        audio_bytes=18_000,
    )

    assert timeline["ready"] is True
    assert timeline["duration_seconds"] == pytest.approx(3.0)
    assert timeline["cues"] == [
        {"end_seconds": 1.0, "paragraph_index": 0, "start_seconds": 0.0},
        {"end_seconds": 3.0, "paragraph_index": 1, "start_seconds": 1.0},
    ]


def test_combines_compatible_wav_chunks_with_a_short_pause() -> None:
    combined = combine_wav_chunks([make_wav_bytes(frame_count=100), make_wav_bytes(frame_count=200)])

    with wave.open(BytesIO(combined), "rb") as audio:
        pause_frames = round(audio.getframerate() * AUDIOBOOK_PAUSE_MILLISECONDS / 1_000)
        assert audio.getnchannels() == 1
        assert audio.getsampwidth() == 2
        assert audio.getnframes() == 100 + pause_frames + 200


def test_parses_base64_wav_from_mimo_response() -> None:
    wav_bytes = make_wav_bytes()

    parsed = parse_tts_wav_response(
        {"choices": [{"message": {"audio": {"data": base64.b64encode(wav_bytes).decode("ascii")}}}]}
    )

    assert parsed == wav_bytes
    with pytest.raises(ValueError, match="no audio data"):
        parse_tts_wav_response({"choices": [{"message": {}}]})


@pytest.mark.asyncio
async def test_requests_mimo_tts_using_server_side_credentials() -> None:
    wav_bytes = make_wav_bytes()
    seen_request: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_request
        seen_request = request
        return httpx.Response(
            200,
            json={"choices": [{"message": {"audio": {"data": base64.b64encode(wav_bytes).decode("ascii")}}}]},
        )

    settings = Settings(
        ai_translation_api_key="server-secret",
        ai_translation_base_url="https://tts.example/v1",
        audiobook_tts_model="mimo-v2.5-tts",
        audiobook_tts_voice="Chloe",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await request_tts_wav("Chapter body", settings, client=client)

    assert result == wav_bytes
    assert seen_request is not None
    assert seen_request.url == "https://tts.example/v1/chat/completions"
    assert seen_request.headers["Authorization"] == "Bearer server-secret"
    payload = json.loads(seen_request.content)
    assert payload["model"] == "mimo-v2.5-tts"
    assert payload["messages"][1] == {"role": "assistant", "content": "Chapter body"}
    assert payload["audio"] == {"format": "wav", "voice": "Chloe"}


@pytest.mark.asyncio
async def test_streams_pcm_deltas_from_mimo_sse_response() -> None:
    first_pcm = b"\x01\x00" * 20
    second_pcm = b"\x02\x00" * 10
    events = [
        {"choices": [{"delta": {"audio": {"data": base64.b64encode(first_pcm).decode("ascii")}}}]},
        {"choices": [{"delta": {"audio": {"data": base64.b64encode(second_pcm).decode("ascii")}}}]},
    ]
    sse = "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"
    seen_request: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_request
        seen_request = request
        return httpx.Response(200, content=sse, headers={"Content-Type": "text/event-stream"})

    settings = Settings(ai_translation_api_key="server-secret", ai_translation_base_url="https://tts.example/v1")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        chunks = [chunk async for chunk in stream_tts_pcm("Chapter body", settings, client=client)]

    assert chunks == [first_pcm, second_pcm]
    assert seen_request is not None
    payload = json.loads(seen_request.content)
    assert payload["stream"] is True
    assert payload["audio"] == {"format": "pcm16", "voice": "Chloe"}


@pytest.mark.asyncio
async def test_chapter_stream_yields_immediately_without_writing_audio_cache(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    pcm = b"\x01\x00" * 100

    async def fake_stream_tts_pcm(_text: str, _settings: Settings, *, client: httpx.AsyncClient):
        del client
        yield pcm

    monkeypatch.setattr(audiobook_module, "stream_tts_pcm", fake_stream_tts_pcm)
    descriptor = ChapterAudiobook(
        audio_id="stream-test",
        cached=False,
        chapter_index=1,
        path=tmp_path / "chapter.wav",
        text="A" * 701,
        timeline_path=tmp_path / "chapter.timeline.json",
    )
    settings = Settings(ai_translation_api_key="server-secret", ai_translation_base_url="https://tts.example/v1")
    stream = stream_chapter_audiobook(descriptor, settings)

    first_chunk = await anext(stream)
    remaining = [chunk async for chunk in stream]
    streamed = first_chunk + b"".join(remaining)

    assert first_chunk == build_wav_header(None)
    assert streamed.startswith(b"RIFF")
    assert not descriptor.path.exists()
    assert not descriptor.timeline_path.exists()


@pytest.mark.asyncio
async def test_default_edge_voice_streams_mp3_without_credentials_or_cache(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio = b"ID3" + b"\x01" * 997
    captured: dict[str, object] = {}

    class FakeCommunicate:
        def __init__(self, text: str, voice: str, **kwargs: object) -> None:
            captured.update({"text": text, "voice": voice, **kwargs})

        async def stream(self):
            yield {"type": "SentenceBoundary", "offset": 0, "duration": 1_000_000, "text": "第一段。"}
            yield {"type": "audio", "data": audio}

    monkeypatch.setattr(audiobook_module.edge_tts, "Communicate", FakeCommunicate)
    descriptor = ChapterAudiobook(
        audio_id="edge-stream-test",
        cached=False,
        chapter_index=1,
        path=tmp_path / "chapter.mp3",
        text="第一段。",
        timeline_path=tmp_path / "chapter.timeline.json",
        media_type="audio/mpeg",
        provider="edge",
        voice="zh-CN-XiaoxiaoNeural",
    )

    streamed = b"".join([chunk async for chunk in stream_chapter_audiobook(descriptor, Settings())])

    assert streamed == audio
    assert not descriptor.path.exists()
    assert not descriptor.timeline_path.exists()
    assert captured == {
        "boundary": "SentenceBoundary",
        "rate": "-5%",
        "text": "第一段。",
        "voice": "zh-CN-XiaoxiaoNeural",
    }
@pytest.mark.asyncio
async def test_same_chapter_streams_start_independently_without_audio_files(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    audio = b"ID3" + b"\x01" * 997

    class FakeCommunicate:
        def __init__(self, *_args, **_kwargs):
            pass

        async def stream(self):
            yield {"type": "audio", "data": audio}
            yield {"type": "audio", "data": audio}

    monkeypatch.setattr(audiobook_module.edge_tts, "Communicate", FakeCommunicate)
    descriptor = ChapterAudiobook(
        audio_id="shared-chapter", cached=False, chapter_index=1,
        path=tmp_path / "chapter.mp3", text="同一章。", provider="edge", voice="zh-CN-XiaoxiaoNeural",
    )
    first = stream_chapter_audiobook(descriptor, Settings())
    second = stream_chapter_audiobook(descriptor, Settings())
    second_packet = None
    try:
        assert await anext(first) == audio
        second_packet = asyncio.create_task(anext(second))
        done, _ = await asyncio.wait({second_packet}, timeout=1)
        assert second_packet in done, "An independent stream must not wait for the first stream to finish"
        assert second_packet.result() == audio
        await first.aclose()
        assert await anext(second) == audio
    finally:
        if second_packet is not None:
            second_packet.cancel()
            await asyncio.gather(second_packet, return_exceptions=True)
        await first.aclose()
        await second.aclose()
    assert list(tmp_path.iterdir()) == []


def test_signed_audiobook_url_streams_without_persisting_audio(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    path = tmp_path / "chapter.wav"
    descriptor = ChapterAudiobook(
        audio_id="audio-test",
        cached=False,
        chapter_index=1,
        path=path,
        text="第一段。\n\n第二段。",
        timeline_path=tmp_path / "chapter.timeline.json",
    )

    monkeypatch.setattr(reader_api, "get_chapter_audiobook", lambda **_kwargs: descriptor)

    monkeypatch.setattr(files_api, "get_chapter_audiobook", lambda **_kwargs: descriptor)

    async def stream(_descriptor, _settings):
        yield b"temporary-audio"

    monkeypatch.setattr(files_api, "stream_chapter_audiobook", stream)

    ticket_response = client.post("/api/v1/books/b1/reader/chapters/1/audiobook", headers=auth_headers)

    assert ticket_response.status_code == 200
    ticket = ticket_response.json()
    assert ticket["cached"] is False
    assert "server-secret" not in ticket["audio_url"]
    assert ticket["timeline_url"].endswith(ticket["audio_url"].split("?", 1)[1])

    timeline_response = client.get(ticket["timeline_url"])
    assert timeline_response.status_code == 200
    timeline = timeline_response.json()
    assert timeline["ready"] is False
    assert [cue["paragraph_index"] for cue in timeline["cues"]] == [0, 1]
    assert timeline["duration_seconds"] > 0

    audio_response = client.get(ticket["audio_url"])
    assert audio_response.status_code == 200
    assert audio_response.content == b"temporary-audio"
    assert not path.exists()


def test_default_audiobook_ticket_does_not_require_user_credentials(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    descriptor = ChapterAudiobook(
        audio_id="default-edge-ticket",
        cached=False,
        chapter_index=1,
        path=tmp_path / "chapter.mp3",
        text="第一段。",
        timeline_path=tmp_path / "chapter.timeline.json",
        media_type="audio/mpeg",
        provider="edge",
        voice="zh-CN-XiaoxiaoNeural",
    )
    monkeypatch.setattr(reader_api, "get_chapter_audiobook", lambda **_kwargs: descriptor)

    response = client.post("/api/v1/books/b1/reader/chapters/1/audiobook", headers=auth_headers)

    assert response.status_code == 200
    assert response.json()["cached"] is False
    assert "/audiobooks/1?ticket=" in response.json()["audio_url"]


def test_book_deletion_includes_audiobook_cache_directory() -> None:
    directories = get_book_storage_directories("owner-1", "book-1")

    assert directories[0].as_posix() == "audiobooks/owner-1/book-1"
