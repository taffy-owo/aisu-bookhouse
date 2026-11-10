"""Recognize standalone chapter headings without treating narrative prefixes as titles."""

import re


CHAPTER_PREFIX = (
    r"(?:第[ \t\u3000]*[0-9０-９一二三四五六七八九十百千万零〇两兩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]{1,24}"
    r"[ \t\u3000]*[章节節卷回话話幕篇]|序章|序幕|终章|終章|尾声|尾聲|后记|後記|番外|extra\b)"
)
# A separator makes even a sentence-shaped episode title unambiguous. Keep the
# common compact form (第一章雪夜), but not prose such as 第十二章的线索……。
TITLE_SEPARATOR = r"[ \t\u3000:：、.．·・—–－\-（(【\[「『《〈]"
COMPACT_TITLE = r"(?![的地得是在将已又也就还還都里裡中内內外上下之はがをにでと])[^\r\n，。！？!?…]*"
CHAPTER_PATTERN = re.compile(
    rf"(?m)^[ \t\u3000]*((?=[^\r\n]{{1,255}}\r?$)(?:{CHAPTER_PREFIX}(?:{TITLE_SEPARATOR}[^\r\n]*|{COMPACT_TITLE})"
    rf"|chapter[ \t\u3000]*[0-9０-９]{{1,24}}(?:{TITLE_SEPARATOR}[^\r\n]*|)))[ \t\u3000\r]*$",
    re.IGNORECASE,
)
