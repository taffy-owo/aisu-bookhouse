// A small, real multi-page PDF keeps worker, canvas and text extraction active.
export function createPdfFixture(pageCount, scanned = false) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let page = 1; page <= pageCount; page++) {
    const contentId = 5 + (page - 1) * 2;
    const text = scanned ? '0.96 0.94 0.91 rg 0 0 600 800 re f 0.2 0.2 0.2 RG ' + Array.from({ length: 28 }, (_, line) => `42 ${740-line*22} m 558 ${740-line*22} l S `).join('')
      : `BT /F1 16 Tf 42 750 Td (Page ${page}) Tj 0 -30 Td /F1 12 Tf ` + Array.from({ length: 28 }, (_, line) => `(Reading page ${page}, line ${line + 1}. The story continues beside the quiet window.) Tj 0 -22 Td `).join('') + 'ET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length, count = objects.length + 1;
  return pdf + `xref\n0 ${count}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
}
