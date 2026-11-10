export function findTags(xml, tagName) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  return Array.from(xml.matchAll(tagPattern), (match) => match[0]);
}

export function getAttributes(tag) {
  const attributes = {};
  const attributePattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  for (const match of tag.matchAll(attributePattern)) {
    attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }

  return attributes;
}

export function readXmlText(xml, tagName) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(tagPattern);
  const text = match?.[1]?.replace(/<[^>]+>/g, '').trim();

  return text ? decodeXmlEntities(text) : undefined;
}

function decodeXmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
