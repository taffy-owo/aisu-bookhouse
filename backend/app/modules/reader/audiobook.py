import asyncio
import base64
import binascii
from collections.abc import AsyncIterator
from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import struct
from typing import BinaryIO
import wave

import edge_tts
import httpx
from app.core.safe_outbound import public_https_client

from app.core.config import Settings
from app.core.storage import get_storage_root, resolve_storage_path, safe_storage_segment
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.repository import BookRepository
from app.modules.reader.service import get_reader_chapter


AUDIOBOOK_MAX_CHAPTER_CHARS = 100_000
AUDIOBOOK_MAX_CHUNK_CHARS = 700
AUDIOBOOK_PAUSE_MILLISECONDS = 140
AUDIOBOOK_TIMEOUT_SECONDS = 120.0
AUDIOBOOK_TTS_CONCURRENCY = 4
AUDIOBOOK_PCM_CHANNELS = 1
AUDIOBOOK_PCM_SAMPLE_WIDTH = 2
AUDIOBOOK_PCM_SAMPLE_RATE = 24_000
AUDIOBOOK_FILE_READ_SIZE = 256 * 1024
AUDIOBOOK_STYLE_VERSION = "novel-narration-v1"
AUDIOBOOK_STYLE_PROMPT = "自然、温柔、沉浸式的有声书旁白。普通话或正文原语言发音清晰，语速稍慢，克制表达情绪，保留对话语气，不添加正文以外的内容。"
TRANSIENT_TTS_STATUS_CODES = {408, 429, 500, 502, 503, 504}
DEFAULT_EDGE_TTS_PROVIDER = "edge-tts-v1"
DEFAULT_EDGE_TTS_CHINESE_VOICE = "zh-CN-XiaoxiaoNeural"
DEFAULT_EDGE_TTS_JAPANESE_VOICE = "ja-JP-NanamiNeural"
DEFAULT_EDGE_TTS_RATE = "-5%"
EDGE_TTS_TICKS_PER_SECOND = 10_000_000
EDGE_TTS_MP3_BITS_PER_SECOND = 48_000
_edge_tts_semaphore = asyncio.Semaphore(2)


@dataclass(frozen=True)
class ChapterAudiobook:
    audio_id: str
    cached: bool
    chapter_index: int
    path: Path
    text: str = ""
    timeline_path: Path | None = None
    media_type: str = "audio/wav"
    provider: str = "custom"
    voice: str = ""


@dataclass(frozen=True)
class AudiobookTextPart:
    paragraph_index: int
    text: str


@dataclass(frozen=True)
class AudiobookSegment:
    parts: tuple[AudiobookTextPart, ...]
    text: str


def get_chapter_audiobook(
    *,
    asset_repository: BookAssetRepository,
    book_id: str,
    book_repository: BookRepository,
    chapter_index: int,
    owner_id: str,
    settings: Settings,
) -> ChapterAudiobook | None:
    book = book_repository.get_accessible(owner_id, book_id)
    if not book or book.reader_type not in {"epub", "text"}:
        return None
    chapter = get_reader_chapter(
        asset_repository=asset_repository,
        book_id=book_id,
        book_repository=book_repository,
        chapter_index=chapter_index,
        owner_id=owner_id,
        settings=settings,
    )
    if not chapter:
        return None

    text = normalize_audiobook_text(chapter.content)
    if not text:
        return None
    if len(text) > AUDIOBOOK_MAX_CHAPTER_CHARS:
        raise ValueError("本章正文过长，暂时无法生成听书音频")

    custom_provider = has_custom_audiobook_provider(settings)
    voice = settings.audiobook_tts_voice if custom_provider else choose_default_edge_voice(text, language=book.language)
    provider_model = (
        f"{settings.ai_translation_base_url}\0{settings.audiobook_tts_model}"
        if custom_provider
        else DEFAULT_EDGE_TTS_PROVIDER
    )
    audio_id = build_audiobook_id(text, provider_model, voice)
    suffix = ".wav" if custom_provider else ".mp3"
    relative_path = (
        Path("audiobooks")
        / safe_storage_segment(book.owner_id)
        / safe_storage_segment(book.id)
        / f"{audio_id}{suffix}"
    )
    path = resolve_storage_path(get_storage_root(settings), relative_path)
    return ChapterAudiobook(
        audio_id=audio_id,
        cached=False,
        chapter_index=chapter_index,
        path=path,
        text=text,
        timeline_path=path.with_suffix(".timeline.json"),
        media_type="audio/wav" if custom_provider else "audio/mpeg",
        provider="custom" if custom_provider else "edge",
        voice=voice,
    )


async def stream_chapter_audiobook(descriptor: ChapterAudiobook, settings: Settings) -> AsyncIterator[bytes]:
    """Stream generated audio for the current request without persisting it."""
    if not descriptor.text:
        raise ValueError("本章没有可朗读的正文")

    if descriptor.provider == "edge":
        async for data in generate_default_edge_audiobook(descriptor):
            yield data
        return

    if not settings.ai_translation_api_key or not settings.ai_translation_base_url:
        raise RuntimeError("听书语音尚未配置")

    segments = split_audiobook_segments(descriptor.text)
    if not segments:
        raise ValueError("本章没有可朗读的正文")

    pending: list[asyncio.Task[bytes]] = []
    try:
        streaming_header = build_wav_header(None)
        yield streaming_header

        semaphore = asyncio.Semaphore(max(1, AUDIOBOOK_TTS_CONCURRENCY - 1))
        async with public_https_client(timeout=AUDIOBOOK_TIMEOUT_SECONDS) as client:

            async def collect(chunk: str) -> bytes:
                async with semaphore:
                    parts = [part async for part in stream_tts_pcm(chunk, settings, client=client)]
                data = b"".join(parts)
                if not data:
                    raise RuntimeError("TTS stream returned no audio data")
                return data

            pending = [asyncio.create_task(collect(segment.text)) for segment in segments[1:]]
            first_chunk_size = 0
            async for data in stream_tts_pcm(segments[0].text, settings, client=client):
                first_chunk_size += len(data)
                yield data
            if first_chunk_size == 0:
                raise RuntimeError("TTS stream returned no audio data")
            pause = build_pcm_pause()
            for task in pending:
                data = await task
                yield pause
                for offset in range(0, len(data), AUDIOBOOK_FILE_READ_SIZE):
                    packet = data[offset : offset + AUDIOBOOK_FILE_READ_SIZE]
                    yield packet
    finally:
        for task in pending:
            if not task.done():
                task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)


async def generate_default_edge_audiobook(descriptor: ChapterAudiobook) -> AsyncIterator[bytes]:
    if not descriptor.text or not descriptor.voice:
        raise ValueError("本章没有可朗读的正文")

    audio_bytes = 0
    communicator = edge_tts.Communicate(
        descriptor.text,
        descriptor.voice,
        rate=DEFAULT_EDGE_TTS_RATE,
        boundary="SentenceBoundary",
    )
    async with _edge_tts_semaphore:
        async for message in communicator.stream():
            message_type = message.get("type")
            if message_type == "audio":
                data = message.get("data")
                if not isinstance(data, bytes) or not data:
                    continue
                audio_bytes += len(data)
                yield data

    if audio_bytes < 512:
        raise RuntimeError("免费默认语音没有返回有效音频")


def has_custom_audiobook_provider(settings: Settings) -> bool:
    return bool(
        settings.ai_translation_api_key
        and settings.ai_translation_base_url
        and settings.audiobook_tts_model
    )


def choose_default_edge_voice(text: str, *, language: str = "und") -> str:
    if language == "ja":
        return DEFAULT_EDGE_TTS_JAPANESE_VOICE
    if language == "zh":
        return DEFAULT_EDGE_TTS_CHINESE_VOICE
    kana_count = len(re.findall(r"[\u3040-\u30ff\u31f0-\u31ff]", text))
    compact_length = len(re.sub(r"\s+", "", text))
    if compact_length and kana_count >= max(2, compact_length * 0.01):
        return DEFAULT_EDGE_TTS_JAPANESE_VOICE
    return DEFAULT_EDGE_TTS_CHINESE_VOICE


def normalize_audiobook_text(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = re.sub(r"[\u200b-\u200d\ufeff]", "", normalized)
    paragraphs = [re.sub(r"[ \t\u3000]+", " ", paragraph).strip() for paragraph in re.split(r"\n{2,}", normalized)]
    return "\n\n".join(paragraph for paragraph in paragraphs if paragraph)


def split_audiobook_text(text: str, max_chars: int = AUDIOBOOK_MAX_CHUNK_CHARS) -> list[str]:
    return [segment.text for segment in split_audiobook_segments(text, max_chars=max_chars)]


def split_audiobook_segments(text: str, max_chars: int = AUDIOBOOK_MAX_CHUNK_CHARS) -> list[AudiobookSegment]:
    if not text:
        return []
    units: list[AudiobookTextPart] = []
    for paragraph_index, paragraph in enumerate(text.split("\n\n")):
        if len(paragraph) <= max_chars:
            units.append(AudiobookTextPart(paragraph_index=paragraph_index, text=paragraph))
            continue
        sentences = [part.strip() for part in re.split(r"(?<=[。！？!?…])", paragraph) if part.strip()]
        for sentence in sentences or [paragraph]:
            units.extend(
                AudiobookTextPart(paragraph_index=paragraph_index, text=sentence[offset : offset + max_chars])
                for offset in range(0, len(sentence), max_chars)
            )

    segments: list[AudiobookSegment] = []
    current_parts: list[AudiobookTextPart] = []
    current = ""
    for unit in units:
        separator = "\n\n" if current_parts and current_parts[-1].paragraph_index != unit.paragraph_index else ""
        candidate = f"{current}{separator}{unit.text}" if current else unit.text
        if current and len(candidate) > max_chars:
            segments.append(AudiobookSegment(parts=tuple(current_parts), text=current))
            current_parts = [unit]
            current = unit.text
        else:
            current_parts.append(unit)
            current = candidate
    if current:
        segments.append(AudiobookSegment(parts=tuple(current_parts), text=current))
    return segments


async def request_tts_wav(text: str, settings: Settings, *, client: httpx.AsyncClient | None = None) -> bytes:
    payload = {
        "model": settings.audiobook_tts_model,
        "messages": [
            {"role": "user", "content": AUDIOBOOK_STYLE_PROMPT},
            {"role": "assistant", "content": text},
        ],
        "audio": {"format": "wav", "voice": settings.audiobook_tts_voice},
        "stream": False,
    }
    if client is None:
        async with public_https_client(timeout=AUDIOBOOK_TIMEOUT_SECONDS) as owned_client:
            return await request_tts_wav(text, settings, client=owned_client)

    for attempt in range(3):
        response = await client.post(
            f"{settings.ai_translation_base_url}/chat/completions",
            headers={"Authorization": f"Bearer {settings.ai_translation_api_key}"},
            json=payload,
        )
        if response.status_code in TRANSIENT_TTS_STATUS_CODES and attempt < 2:
            await asyncio.sleep(0.8 * (attempt + 1))
            continue
        response.raise_for_status()
        return parse_tts_wav_response(response.json())
    raise RuntimeError("TTS request failed")


async def stream_tts_pcm(text: str, settings: Settings, *, client: httpx.AsyncClient) -> AsyncIterator[bytes]:
    payload = {
        "model": settings.audiobook_tts_model,
        "messages": [
            {"role": "user", "content": AUDIOBOOK_STYLE_PROMPT},
            {"role": "assistant", "content": text},
        ],
        "audio": {"format": "pcm16", "voice": settings.audiobook_tts_voice},
        "stream": True,
    }
    for attempt in range(3):
        emitted_audio = False
        try:
            async with client.stream(
                "POST",
                f"{settings.ai_translation_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {settings.ai_translation_api_key}"},
                json=payload,
            ) as response:
                if response.status_code in TRANSIENT_TTS_STATUS_CODES and attempt < 2:
                    await response.aread()
                    await asyncio.sleep(0.8 * (attempt + 1))
                    continue
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    body = line[5:].strip()
                    if not body or body == "[DONE]":
                        continue
                    data = parse_tts_pcm_event(json.loads(body))
                    if data is None:
                        continue
                    emitted_audio = True
                    yield data
            if not emitted_audio:
                raise RuntimeError("TTS stream returned no audio data")
            return
        except (httpx.TransportError, json.JSONDecodeError, ValueError, RuntimeError):
            if emitted_audio or attempt >= 2:
                raise
            await asyncio.sleep(0.8 * (attempt + 1))
    raise RuntimeError("TTS stream failed")


def parse_tts_pcm_event(payload: object) -> bytes | None:
    if not isinstance(payload, dict):
        raise ValueError("TTS stream event is not an object")
    choices = payload.get("choices")
    delta = choices[0].get("delta") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
    audio = delta.get("audio") if isinstance(delta, dict) else None
    encoded = audio.get("data") if isinstance(audio, dict) else None
    if encoded is None:
        return None
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("TTS stream contains invalid audio data")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("TTS stream contains invalid base64 audio") from error
    if not data or len(data) % AUDIOBOOK_PCM_SAMPLE_WIDTH != 0:
        raise ValueError("TTS stream contains invalid PCM16 audio")
    return data


def build_wav_header(pcm_size: int | None) -> bytes:
    data_size = 0xFFFFFFFF if pcm_size is None else pcm_size
    riff_size = 0xFFFFFFFF if pcm_size is None else pcm_size + 36
    if data_size > 0xFFFFFFFF or riff_size > 0xFFFFFFFF:
        raise ValueError("Audiobook WAV file is too large")
    byte_rate = AUDIOBOOK_PCM_SAMPLE_RATE * AUDIOBOOK_PCM_CHANNELS * AUDIOBOOK_PCM_SAMPLE_WIDTH
    block_align = AUDIOBOOK_PCM_CHANNELS * AUDIOBOOK_PCM_SAMPLE_WIDTH
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        riff_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        AUDIOBOOK_PCM_CHANNELS,
        AUDIOBOOK_PCM_SAMPLE_RATE,
        byte_rate,
        block_align,
        AUDIOBOOK_PCM_SAMPLE_WIDTH * 8,
        b"data",
        data_size,
    )


def build_pcm_pause() -> bytes:
    frame_count = round(AUDIOBOOK_PCM_SAMPLE_RATE * AUDIOBOOK_PAUSE_MILLISECONDS / 1_000)
    return b"\0" * frame_count * AUDIOBOOK_PCM_CHANNELS * AUDIOBOOK_PCM_SAMPLE_WIDTH


def get_audiobook_timeline(descriptor: ChapterAudiobook) -> dict[str, object]:
    return build_estimated_timeline(descriptor.text, estimate_audiobook_duration(descriptor.text), ready=False)


def build_segment_timeline(segments: list[AudiobookSegment], pcm_sizes: list[int]) -> dict[str, object]:
    if len(segments) != len(pcm_sizes):
        raise ValueError("Audiobook segment timeline does not match generated audio")
    bytes_per_second = AUDIOBOOK_PCM_SAMPLE_RATE * AUDIOBOOK_PCM_CHANNELS * AUDIOBOOK_PCM_SAMPLE_WIDTH
    cues: list[dict[str, float | int]] = []
    cursor = 0.0
    for segment_index, (segment, pcm_size) in enumerate(zip(segments, pcm_sizes, strict=True)):
        segment_duration = pcm_size / bytes_per_second
        weights = [get_speech_weight(part.text) for part in segment.parts]
        total_weight = sum(weights) or 1.0
        for part, weight in zip(segment.parts, weights, strict=True):
            start = cursor
            cursor += segment_duration * weight / total_weight
            if cues and cues[-1]["paragraph_index"] == part.paragraph_index:
                cues[-1]["end_seconds"] = round(cursor, 3)
            else:
                cues.append(
                    {
                        "end_seconds": round(cursor, 3),
                        "paragraph_index": part.paragraph_index,
                        "start_seconds": round(start, 3),
                    }
                )
        if segment_index < len(segments) - 1:
            cursor += AUDIOBOOK_PAUSE_MILLISECONDS / 1_000
    return {"cues": cues, "duration_seconds": round(cursor, 3), "ready": True}


def build_estimated_timeline(text: str, duration: float, *, ready: bool) -> dict[str, object]:
    paragraphs = [paragraph for paragraph in text.split("\n\n") if paragraph]
    weights = [get_speech_weight(paragraph) for paragraph in paragraphs]
    total_weight = sum(weights) or 1.0
    cursor = 0.0
    cues: list[dict[str, float | int]] = []
    for paragraph_index, weight in enumerate(weights):
        start = cursor
        cursor += duration * weight / total_weight
        cues.append(
            {
                "end_seconds": round(cursor, 3),
                "paragraph_index": paragraph_index,
                "start_seconds": round(start, 3),
            }
        )
    return {"cues": cues, "duration_seconds": round(duration, 3), "ready": ready}


def build_edge_tts_timeline(
    text: str,
    boundaries: list[dict[str, object]],
    audio_bytes: int,
) -> dict[str, object]:
    byte_duration = audio_bytes * 8 / EDGE_TTS_MP3_BITS_PER_SECOND
    paragraphs = [paragraph for paragraph in text.split("\n\n") if paragraph]
    measured_ends: dict[int, float] = {}
    paragraph_cursor = 0
    boundary_duration = 0.0
    for boundary in boundaries:
        sentence = boundary.get("text")
        offset = boundary.get("offset")
        duration = boundary.get("duration")
        if not isinstance(sentence, str) or not isinstance(offset, int) or not isinstance(duration, int):
            continue
        for candidate in range(paragraph_cursor, len(paragraphs)):
            if sentence.strip() and sentence.strip() in paragraphs[candidate]:
                paragraph_cursor = candidate
                break
        end_seconds = (offset + duration) / EDGE_TTS_TICKS_PER_SECOND
        measured_ends[paragraph_cursor] = max(measured_ends.get(paragraph_cursor, 0.0), end_seconds)
        boundary_duration = max(boundary_duration, end_seconds)

    total_duration = max(0.1, byte_duration, boundary_duration)
    estimated = build_estimated_timeline(text, total_duration, ready=True)
    cues: list[dict[str, float | int]] = []
    cursor = 0.0
    estimated_cues = estimated["cues"]
    if not isinstance(estimated_cues, list):
        raise ValueError("默认语音时间轴生成失败")
    for index, estimated_cue in enumerate(estimated_cues):
        if not isinstance(estimated_cue, dict):
            continue
        estimated_end = estimated_cue.get("end_seconds")
        fallback_end = float(estimated_end) if isinstance(estimated_end, (int, float)) else cursor + 0.001
        candidate_end = measured_ends.get(index, fallback_end)
        end = min(total_duration, max(cursor + 0.001, candidate_end))
        if index == len(paragraphs) - 1:
            end = total_duration
        cues.append(
            {
                "end_seconds": round(end, 3),
                "paragraph_index": index,
                "start_seconds": round(cursor, 3),
            }
        )
        cursor = end
    return {"cues": cues, "duration_seconds": round(total_duration, 3), "ready": True}


def estimate_audiobook_duration(text: str) -> float:
    compact = re.sub(r"\s+", "", text)
    if not compact:
        return 0.0
    cjk_count = len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]", compact))
    rate = 4.2 if cjk_count >= len(compact) * 0.45 else 13.0
    return max(1.0, get_speech_weight(text) / rate)


def get_speech_weight(text: str) -> float:
    compact_length = len(re.sub(r"\s+", "", text))
    punctuation_pauses = len(re.findall(r"[。！？!?…；;：:]", text))
    return float(max(1, compact_length + punctuation_pauses * 3))


def parse_tts_wav_response(payload: object) -> bytes:
    if not isinstance(payload, dict):
        raise ValueError("TTS response is not an object")
    choices = payload.get("choices")
    message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
    audio = message.get("audio") if isinstance(message, dict) else None
    encoded = audio.get("data") if isinstance(audio, dict) else None
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("TTS response has no audio data")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("TTS response contains invalid audio data") from error
    validate_wav_bytes(data)
    return data


def combine_wav_chunks(chunks: list[bytes]) -> bytes:
    if not chunks:
        raise ValueError("No audiobook chunks were generated")
    output = BytesIO()
    expected: tuple[int, int, int, str] | None = None
    with wave.open(output, "wb") as target:
        for index, chunk in enumerate(chunks):
            with wave.open(BytesIO(chunk), "rb") as source:
                params = (source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getcomptype())
                if expected is None:
                    expected = params
                    target.setnchannels(params[0])
                    target.setsampwidth(params[1])
                    target.setframerate(params[2])
                    target.setcomptype(params[3], source.getcompname())
                elif params != expected:
                    raise ValueError("TTS audio chunks use incompatible WAV formats")
                target.writeframes(source.readframes(source.getnframes()))
                if index < len(chunks) - 1:
                    pause_frames = round(params[2] * AUDIOBOOK_PAUSE_MILLISECONDS / 1000)
                    target.writeframes(b"\0" * pause_frames * params[0] * params[1])
    return output.getvalue()


def validate_wav_bytes(data: bytes) -> None:
    try:
        _validate_wav_stream(BytesIO(data))
    except (EOFError, wave.Error) as error:
        raise ValueError("TTS returned an invalid WAV file") from error


def _validate_wav_stream(source: BinaryIO) -> None:
    try:
        with wave.open(source, "rb") as audio:
            if audio.getnchannels() < 1 or audio.getsampwidth() < 1 or audio.getframerate() < 8000 or audio.getnframes() < 1:
                raise ValueError("TTS returned an empty WAV file")
            frame_size = audio.getnchannels() * audio.getsampwidth()
            if len(audio.readframes(1)) != frame_size:
                raise ValueError("TTS returned a truncated WAV file")
            audio.setpos(audio.getnframes() - 1)
            if len(audio.readframes(1)) != frame_size:
                raise ValueError("TTS returned a truncated WAV file")
    except (EOFError, wave.Error) as error:
        raise ValueError("TTS returned an invalid WAV file") from error


def build_audiobook_id(text: str, model: str, voice: str) -> str:
    identity = json.dumps(
        {"model": model, "style": AUDIOBOOK_STYLE_VERSION, "text": text, "voice": voice},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return sha256(identity.encode("utf-8")).hexdigest()
