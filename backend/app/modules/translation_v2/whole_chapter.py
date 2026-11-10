"""Whole-chapter generation; concurrency is shared between independent jobs."""
from .runtime import StageClient
from .literary_policy import LITERARY_COMMON, LITERARY_PROMPTS, LITERARY_REVIEW_POLICY

WHOLE_CHAPTER_PROMPTS = {
    'edit': '通读完整原文、分析和 candidate 整话译稿，做自然流畅的中文编辑，保持人物口吻、事实、含混、信息强弱和段落边界。不补写内容。返回完整编辑后的 blocks（包括未改动段落），每块包含 block_id、segments；不是 patches，不返回 base_hash。不省略任何原段落。',
    'proofread': '对 candidate 整话译稿做中文错字、语法、引号和排版校对，保留事实与人物口吻，不重写剧情。返回完整校对后的 blocks（包括未改动段落），每块包含 block_id、segments；不是 patches，不返回 base_hash。不省略任何原段落。',
}


class WholeChapterClient(StageClient):
    whole_chapter = True
    direct_translation = True
    focused_repair_fallback = True
    review_full_after_repair = True
    prompt_overrides = {**WHOLE_CHAPTER_PROMPTS, **LITERARY_PROMPTS}
    common_overrides = {stage: LITERARY_COMMON for stage in LITERARY_PROMPTS}
    quality_policy = LITERARY_REVIEW_POLICY
