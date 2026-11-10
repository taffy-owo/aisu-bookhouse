"""Lossless glossary encoding at the model boundary; storage is untouched."""

GLOSSARY_TABLE_INSTRUCTION = (
    '输入 glossary 若为 fields/rows 表格，每行的值按 fields 中的列名顺序对应原术语字段。'
    '全部字段值均保留，空字符串仍是空字符串。evidence_block_id 是历史证据位置，不是待输出段落编号；'
    '备注中的“本话/此处”须结合该证据位置理解，不扩大成当前章节的事实。'
    '术语表只用于理解与译名一致性，不回显表格；仅输出 output_schema 要求的当前段落结果。'
)


def glossary_table(value):
    if not isinstance(value, list) or not value or not all(isinstance(row, dict) for row in value):
        return value
    keys = set(value[0])
    if not {'source', 'target'} <= keys or any(set(row) != keys for row in value):
        return value
    ordered = ['source', 'target', 'evidence_block_id', 'evidence_quote', 'note']
    fields = [key for key in ordered if key in keys] + sorted(keys - set(ordered))
    return {'fields': fields, 'rows': [[row[key] for key in fields] for row in value]}


def compact_request_glossary(payload):
    """Only replace explicit glossary locations; never traverse source prose."""
    result = dict(payload)
    changed = False
    if 'glossary' in payload:
        table = glossary_table(payload['glossary'])
        if table is not payload['glossary']:
            result['glossary'] = table
            changed = True
    context = payload.get('context')
    if isinstance(context, dict) and 'glossary' in context:
        table = glossary_table(context['glossary'])
        if table is not context['glossary']:
            result['context'] = {**context, 'glossary': table}
            changed = True
    return result, changed
