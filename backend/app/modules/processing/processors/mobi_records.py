"""Palm/MOBI byte boundaries, declared encodings and bounded PalmDOC decompression."""
import struct

from app.core.storage import StorageLimitExceededError
from app.modules.processing.processors.txt_processor import decode_text

PALMDOC_COMPRESSION_NONE = 1
PALMDOC_COMPRESSION_LZ77 = 2
MOBI_COMPRESSION_HUFF_CDIC = 17480


class MobiProcessingError(ValueError):
    pass


class MobiNoTextError(MobiProcessingError):
    """A valid image-only book can use the comic reader."""
    pass


def read_palm_record_offsets(data: bytes) -> list[int]:
    if len(data) < 78:
        raise MobiProcessingError("Palm database header is incomplete")

    record_count = read_uint16(data, 76)
    record_list_end = 78 + record_count * 8
    if record_count < 1 or len(data) < record_list_end:
        raise MobiProcessingError("Palm database record list is incomplete")

    offsets = [read_uint32(data, 78 + index * 8) for index in range(record_count)]
    if any(offset < record_list_end or offset >= len(data) for offset in offsets):
        raise MobiProcessingError("Palm database record offset is invalid")
    if any(right <= left for left, right in zip(offsets, offsets[1:])):
        raise MobiProcessingError("Palm database record offset order is invalid")
    return offsets


def read_record(data: bytes, record_offsets: list[int], index: int) -> bytes:
    start = record_offsets[index]
    end = record_offsets[index + 1] if index + 1 < len(record_offsets) else len(data)
    if end < start:
        raise MobiProcessingError("Palm database record offset order is invalid")
    return data[start:end]


def read_palmdoc_header(first_record: bytes) -> tuple[int, int, int]:
    return read_uint16(first_record, 0), read_uint32(first_record, 4), read_uint16(first_record, 8)


def read_mobi_encoding(first_record: bytes) -> int | None:
    mobi_offset = first_record.find(b"MOBI", 16)
    if mobi_offset < 0 or len(first_record) < mobi_offset + 16:
        return None
    return read_uint32(first_record, mobi_offset + 12)


def read_mobi_extra_flags(first_record: bytes) -> int:
    mobi_offset = first_record.find(b"MOBI", 16)
    if mobi_offset < 0 or len(first_record) < mobi_offset + 228:
        return 0
    if read_uint32(first_record, mobi_offset + 4) < 228:
        return 0
    return read_uint16(first_record, mobi_offset + 226)


def strip_mobi_record_extras(record: bytes, flags: int) -> bytes:
    remaining = record
    entries = flags >> 1
    while entries:
        if entries & 1:
            size = 0
            for position, byte in enumerate(reversed(remaining[-4:])):
                size |= (byte & 0x7F) << (position * 7)
                if byte & 0x80:
                    break
            else:
                raise MobiProcessingError("MOBI trailing record size is incomplete")
            if size < position + 1 or size > len(remaining):
                raise MobiProcessingError("MOBI trailing record size is invalid")
            remaining = remaining[:-size]
        entries >>= 1
    if flags & 1:
        if not remaining:
            raise MobiProcessingError("MOBI multibyte overlap is missing")
        size = (remaining[-1] & 3) + 1
        if size > len(remaining):
            raise MobiProcessingError("MOBI multibyte overlap is incomplete")
        remaining = remaining[:-size]
    return remaining


def read_mobi_title(first_record: bytes) -> str | None:
    mobi_offset = first_record.find(b"MOBI", 16)
    if mobi_offset < 0 or len(first_record) < mobi_offset + 76:
        return None

    title_offset = read_uint32(first_record, mobi_offset + 68)
    title_length = read_uint32(first_record, mobi_offset + 72)
    if title_length <= 0 or title_offset >= len(first_record):
        return None

    raw_title = first_record[title_offset : min(title_offset + title_length, len(first_record))]
    title = decode_mobi_text(raw_title, read_mobi_encoding(first_record)).strip("\x00 \t\r\n")
    return title or None


def decompress_mobi_record(record: bytes, compression: int, max_output_size: int | None = None) -> bytes:
    if compression == PALMDOC_COMPRESSION_NONE:
        if max_output_size is not None and len(record) > max_output_size:
            raise StorageLimitExceededError("MOBI text record exceeds configured size limit")
        return record
    if compression != PALMDOC_COMPRESSION_LZ77:
        raise MobiProcessingError(f"MOBI compression is not supported: {compression}")

    output = bytearray()
    index = 0
    while index < len(record):
        if max_output_size is not None and len(output) > max_output_size:
            raise StorageLimitExceededError("MOBI text record exceeds configured size limit")
        byte = record[index]
        index += 1

        if byte == 0:
            output.append(byte)
        elif byte <= 8:
            if index + byte > len(record):
                raise MobiProcessingError("MOBI PalmDOC literal is incomplete")
            literal = record[index : index + byte]
            output.extend(literal)
            index += len(literal)
        elif byte <= 0x7F:
            output.append(byte)
        elif byte <= 0xBF:
            if index >= len(record):
                raise MobiProcessingError("MOBI PalmDOC back-reference is incomplete")
            value = (byte << 8) | record[index]
            index += 1
            distance = (value >> 3) & 0x7FF
            length = (value & 0x7) + 3
            if distance == 0 or distance > len(output):
                raise MobiProcessingError("MOBI PalmDOC back-reference is invalid")
            for _ in range(length):
                output.append(output[-distance])
        else:
            output.append(0x20)
            output.append(byte ^ 0x80)

        if max_output_size is not None and len(output) > max_output_size:
            raise StorageLimitExceededError("MOBI text record exceeds configured size limit")

    return bytes(output)


def decode_mobi_text(data: bytes, encoding: int | None) -> str:
    try:
        if encoding == 65001:
            return data.decode("utf-8")
        if encoding == 1252:
            return data.decode("cp1252")
        return decode_text(data)
    except UnicodeDecodeError as error:
        raise MobiProcessingError("MOBI text encoding is invalid") from error


def read_uint16(data: bytes, offset: int) -> int:
    return struct.unpack_from(">H", data, offset)[0]


def read_uint32(data: bytes, offset: int) -> int:
    return struct.unpack_from(">L", data, offset)[0]
