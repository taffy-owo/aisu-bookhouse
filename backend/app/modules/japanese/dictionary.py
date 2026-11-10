"""Dictionary lookup, provider degradation and successful response caching."""
import asyncio
import time
from typing import Any

import httpx

from app.modules.japanese.schemas import JapaneseLookupResponse


LOOKUP_TIMEOUT_SECONDS = 4.5
CACHE_TTL_SECONDS = 60 * 60 * 12
MAX_CACHE_ENTRIES = 1000
_lookup_cache: dict[str, tuple[float, JapaneseLookupResponse]] = {}


async def lookup_japanese_text(text: str) -> JapaneseLookupResponse:
    query = " ".join(text.split()).strip()[:160]
    if not query:
        return JapaneseLookupResponse(query="")

    cached = _lookup_cache.get(query)
    if cached and cached[0] > time.monotonic():
        return cached[1]

    async with httpx.AsyncClient(timeout=LOOKUP_TIMEOUT_SECONDS, follow_redirects=True) as client:
        translation_result, dictionary_result = await asyncio.gather(
            _fetch_chinese_translation(client, query),
            _fetch_dictionary_entry(client, query),
            return_exceptions=True,
        )

    translation = translation_result if isinstance(translation_result, str) else None
    dictionary = dictionary_result if isinstance(dictionary_result, dict) else {}
    response = JapaneseLookupResponse(
        query=query,
        reading=_optional_string(dictionary.get("reading")),
        dictionary_form=_optional_string(dictionary.get("dictionary_form")),
        translation=translation,
        english_glosses=[str(value) for value in dictionary.get("english_glosses", []) if isinstance(value, str)][:4],
        available=bool(translation or dictionary),
    )
    if not any(isinstance(result, BaseException) for result in (translation_result, dictionary_result)):
        _store_cache(query, response)
    return response


async def _fetch_chinese_translation(client: httpx.AsyncClient, query: str) -> str | None:
    response = await client.get(
        "https://translate.googleapis.com/translate_a/single",
        params={"client": "gtx", "sl": "ja", "tl": "zh-CN", "dt": "t", "q": query},
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], list):
        return None
    translated_parts = [item[0] for item in payload[0] if isinstance(item, list) and item and isinstance(item[0], str)]
    translated = "".join(translated_parts).strip()
    return translated or None


async def _fetch_dictionary_entry(client: httpx.AsyncClient, query: str) -> dict[str, object]:
    # Jotoba provides JMdict readings and dictionary forms. Failure is isolated
    # from translation so the popover remains useful during a provider outage.
    response = await client.post(
        "https://jotoba.de/api/search/words",
        json={"query": query, "language": "English", "no_english": False},
    )
    response.raise_for_status()
    return parse_jotoba_payload(response.json(), query)


def parse_jotoba_payload(payload: Any, query: str) -> dict[str, object]:
    if not isinstance(payload, dict) or not isinstance(payload.get("words"), list):
        return {}

    words = [word for word in payload["words"] if isinstance(word, dict)]
    if not words:
        return {}
    word = next((candidate for candidate in words if _entry_matches_query(candidate, query)), words[0])
    reading = word.get("reading") if isinstance(word.get("reading"), dict) else {}
    senses = word.get("senses") if isinstance(word.get("senses"), list) else []
    glosses: list[str] = []
    for sense in senses[:3]:
        if not isinstance(sense, dict) or not isinstance(sense.get("glosses"), list):
            continue
        glosses.extend(gloss for gloss in sense["glosses"] if isinstance(gloss, str))
        if len(glosses) >= 4:
            break

    dictionary_form = _optional_string(reading.get("kanji")) or _optional_string(reading.get("kana"))
    return {
        "dictionary_form": dictionary_form,
        "english_glosses": glosses[:4],
        "reading": _optional_string(reading.get("kana")),
    }


def _entry_matches_query(entry: dict[str, object], query: str) -> bool:
    reading = entry.get("reading")
    return isinstance(reading, dict) and query in {reading.get("kanji"), reading.get("kana")}


def _optional_string(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _store_cache(query: str, response: JapaneseLookupResponse) -> None:
    if len(_lookup_cache) >= MAX_CACHE_ENTRIES:
        oldest_key = min(_lookup_cache, key=lambda key: _lookup_cache[key][0])
        _lookup_cache.pop(oldest_key, None)
    _lookup_cache[query] = (time.monotonic() + CACHE_TTL_SECONDS, response)
