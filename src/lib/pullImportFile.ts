import { unzipSync, strFromU8 } from 'fflate';
export async function readPullExport(file: File): Promise<string> {
  if (file.size > 10_000_000) throw new Error('Export exceeds 10 MB. Export without media or use a shorter range.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.txt$/i.test(file.name)) {
    if (bytes.length > 2_000_000) throw new Error('Chat text exceeds 2 MB.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  if (!/\.zip$/i.test(file.name)) throw new Error('Choose a WhatsApp ZIP or TXT export.');
  let count = 0;
  let size = 0;
  const archives = unzipSync(bytes, { filter(entry) {
    count++;
    if (count > 1000) throw new Error('Too many files in this ZIP. Export without media.');
    if (!/\.txt$/i.test(entry.name) || /(?:^|\/)__MACOSX\//.test(entry.name)) return false;
    size += entry.originalSize;
    if (entry.originalSize > 2_000_000 || size > 2_000_000) throw new Error('Uncompressed chat text exceeds 2 MB.');
    return true;
  } });
  const files = Object.entries(archives);
  if (files.length !== 1) throw new Error('ZIP must contain exactly one chat TXT. Import channels separately.');
  if (files[0][1].length > 2_000_000) throw new Error('Chat text exceeds 2 MB.');
  return strFromU8(files[0][1]);
}
