/**
 * Derives the name of the imaged object from the name of a file that does
 * not declare it (TIFF, PNG): "M_27.tif", "NGC7000-HOO-final.png",
 * "IC 5146 stack.tiff".
 *
 * Catalog designations are tried first (M, NGC, IC, Sh2, Abell...; the
 * single-letter designations B and C are excluded, as they turn up too
 * easily by chance in a name), then the whole name (for "Orion Nebula.png").
 * Only a name that the catalog knows is accepted: `search` is the catalog's
 * search by name, passed in from outside so that this module does not have
 * to load the catalog.
 */
export function objectFromFileName(fileName: string, search: (name: string) => unknown | null): string | null {
  const base = (fileName.split(/[\\/]/).pop() ?? '').replace(/(\.[a-z0-9]{1,5})+$/i, '')
  const cleaned = base.replace(/[_.]+/g, ' ').trim()
  if (cleaned === '') return null

  const candidates: string[] = []
  const codes = /\b(M|NGC|IC|Sh\s?2|SH2|Caldwell|Abell|Arp|Barnard|LBN|LDN|vdB|Mel|Cr)[\s-]?(\d{1,4})\b/gi
  let m: RegExpExecArray | null
  while ((m = codes.exec(cleaned)) !== null) {
    const catalog = m[1].replace(/\s/g, '')
    candidates.push(catalog + ' ' + m[2])
    if (/^sh2$/i.test(catalog)) candidates.push('Sh2-' + m[2])
  }
  candidates.push(cleaned)

  for (const c of candidates) if (search(c) !== null) return c
  return null
}
