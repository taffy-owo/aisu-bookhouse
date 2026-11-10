const FIELD_LABELS: Record<string, string> = {
  name: '名称', title: '标题', nickname: '昵称', email: '邮箱', password: '密码',
  base_url: 'Base URL', provider_base_url: '日文翻译 Base URL', audiobook_provider_base_url: '听书 Base URL',
  api_key: 'API Key', audiobook_api_key: '听书 API Key', model: '模型名称', translation_model: '日文翻译模型',
  audiobook_tts_model: '听书语音模型', audiobook_tts_voice: '音色', translation_prompt: '翻译预设',
  max_concurrency: '并发上限', chunk_characters: '分块字数', chunk_paragraphs: '分块段落',
  translation_concurrency: '翻译并发', content: '正文',
};

/** Describe schema failures without reflecting request bodies or credentials. */
export function validationErrorMessage(detail: unknown[]): string {
  const messages = detail.slice(0, 3).map((value) => {
    if (typeof value !== 'object' || value === null) return '填写内容有误，请检查后重试';
    const issue = value as { loc?: unknown[]; type?: string; ctx?: Record<string, unknown> };
    const location = Array.isArray(issue.loc) ? issue.loc : [];
    const fieldName = String(location.at(-1));
    const field = Object.hasOwn(FIELD_LABELS, fieldName) ? FIELD_LABELS[fieldName] : '输入内容';
    const type = typeof issue.type === 'string' ? issue.type : '';
    const modelIndex = location.indexOf('models');
    const index = modelIndex >= 0 ? location[modelIndex + 1] : undefined;
    const label = Number.isInteger(index) && Number(index) >= 0 ? `第 ${Number(index) + 1} 个模型的${field}` : field;
    const limit = (key: string) => typeof issue.ctx?.[key] === 'number' && Number.isFinite(issue.ctx[key]) ? String(issue.ctx[key]) : undefined;
    if (type === 'missing') return `${label}不能为空`;
    if (type.startsWith('int_')) return `${label}请填写整数`;
    if (type === 'greater_than_equal' && limit('ge')) return `${label}不能小于 ${limit('ge')}`;
    if (type === 'less_than_equal' && limit('le')) return `${label}不能大于 ${limit('le')}`;
    if (type === 'string_too_long' && limit('max_length')) return `${label}最多 ${limit('max_length')} 个字符`;
    if (type === 'string_too_short' && limit('min_length')) return `${label}至少 ${limit('min_length')} 个字符`;
    return `${label}填写有误，请检查后重试`;
  });
  return [...new Set(messages)].join('；') || '填写内容有误，请检查后重试';
}
