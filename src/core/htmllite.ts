/**
 * WTE — htmllite: dependency-free static HTML analyzer.
 * Honest scope: this is NOT a browser DOM. It extracts title, meta, links,
 * forms, images, headings and lang for static accessibility/SEO/discovery
 * analysis until the GUI phase adds Playwright-powered real-DOM analysis.
 */

export interface MetaTag {
  name?: string;
  property?: string;
  content?: string;
  charset?: string;
}

export interface LinkTag {
  href: string;
  text: string;
  rel?: string;
}

export interface ImageTag {
  src: string;
  alt: string | null;
}

export interface FormInfo {
  action: string;
  method: string;
  inputs: InputInfo[];
}

export interface InputInfo {
  type: string;
  name: string | null;
  id: string | null;
  hasLabel: boolean;
  ariaLabel: string | null;
  placeholder: string | null;
}

export interface ParsedPage {
  title: string | null;
  lang: string | null;
  hasDoctype: boolean;
  meta: MetaTag[];
  links: LinkTag[];
  images: ImageTag[];
  forms: FormInfo[];
  scripts: { src: string | null; count: number };
  stylesheetCount: number;
  headings: { level: number; text: string }[];
  labelForIds: string[];
  technologies: string[];
}

function getAttr(tag: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseHtml(html: string): ParsedPage {
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const htmlTagM = /<html\b[^>]*>/i.exec(html);

  const meta: MetaTag[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    meta.push({
      name: getAttr(tag, 'name') ?? undefined,
      property: getAttr(tag, 'property') ?? undefined,
      content: getAttr(tag, 'content') ?? undefined,
      charset: getAttr(tag, 'charset') ?? undefined,
    });
  }

  const links: LinkTag[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = m[0];
    const open = tag.slice(0, tag.indexOf('>') + 1);
    links.push({
      href: getAttr(open, 'href') ?? '',
      text: stripTags(tag),
      rel: getAttr(open, 'rel') ?? undefined,
    });
  }

  const images: ImageTag[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    images.push({ src: getAttr(tag, 'src') ?? '', alt: getAttr(tag, 'alt') });
  }

  const labelForIds: string[] = [];
  for (const m of html.matchAll(/<label\b[^>]*>/gi)) {
    const forAttr = getAttr(m[0], 'for');
    if (forAttr) labelForIds.push(forAttr);
  }

  const forms: FormInfo[] = [];
  for (const m of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const formHtml = m[0];
    const openTag = formHtml.slice(0, formHtml.indexOf('>') + 1);
    const inputs: InputInfo[] = [];
    for (const im of formHtml.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
      const itag = im[0];
      const id = getAttr(itag, 'id');
      const wrappedByLabel = /<label\b[^>]*>\s*$/i.test(formHtml.slice(0, im.index));
      inputs.push({
        type: (getAttr(itag, 'type') ?? (im[1] ?? 'text')).toLowerCase(),
        name: getAttr(itag, 'name'),
        id,
        ariaLabel: getAttr(itag, 'aria-label'),
        placeholder: getAttr(itag, 'placeholder'),
        hasLabel: (id !== null && labelForIds.includes(id)) || getAttr(itag, 'aria-label') !== null || wrappedByLabel,
      });
    }
    forms.push({
      action: getAttr(openTag, 'action') ?? '',
      method: (getAttr(openTag, 'method') ?? 'get').toLowerCase(),
      inputs,
    });
  }

  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)];
  const stylesheets = [...html.matchAll(/<link\b[^>]*rel\s*=\s*"stylesheet"[^>]*>/gi)];

  const headings: { level: number; text: string }[] = [];
  for (const m of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    headings.push({ level: parseInt(m[1] ?? '0', 10), text: stripTags(m[2] ?? '') });
  }

  return {
    title: titleM ? stripTags(titleM[1] ?? '') || null : null,
    lang: htmlTagM ? getAttr(htmlTagM[0], 'lang') : null,
    hasDoctype: /^\s*<!doctype html/i.test(html),
    meta,
    links,
    images,
    forms,
    scripts: { src: null, count: scripts.length },
    stylesheetCount: stylesheets.length,
    headings,
    labelForIds,
    technologies: detectTechnologies(html),
  };
}

export function detectTechnologies(html: string): string[] {
  const tech = new Set<string>();
  const genM = /<meta[^>]*name\s*=\s*"generator"[^>]*content\s*=\s*"([^"]*)"/i.exec(html);
  if (genM?.[1]) tech.add(genM[1].trim());
  if (/\bdata-reactroot\b|__REACT_DEVTOOLS|react[-.]dom/i.test(html)) tech.add('React');
  if (/\bng-app\b|_ngcontent-|angular/i.test(html)) tech.add('Angular');
  if (/\bdata-v-[a-f0-9]{6,}\b|vue(\.min)?\.js/i.test(html)) tech.add('Vue');
  if (/__NEXT_DATA__|\/_next\//i.test(html)) tech.add('Next.js');
  if (/__NUXT__|\/_nuxt\//i.test(html)) tech.add('Nuxt');
  if (/jquery(\.min)?\.js/i.test(html)) tech.add('jQuery');
  if (/bootstrap(\.min)?\.(css|js)/i.test(html)) tech.add('Bootstrap');
  if (/tailwind/i.test(html)) tech.add('Tailwind');
  if (/wp-content|wp-includes/i.test(html)) tech.add('WordPress');
  if (/cdn\.shopify\.com/i.test(html)) tech.add('Shopify');
  return [...tech];
}

/** Resolve hrefs to absolute same-origin URLs; returns absolute URLs only when same-origin. */
export function resolveSameOriginLinks(baseUrl: string, links: LinkTag[]): string[] {
  const out = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  for (const l of links) {
    if (!l.href || l.href.startsWith('mailto:') || l.href.startsWith('tel:') || l.href.startsWith('javascript:') || l.href.startsWith('#')) continue;
    try {
      const u = new URL(l.href, base);
      if (u.origin === base.origin && (u.protocol === 'http:' || u.protocol === 'https:')) {
        u.hash = '';
        out.add(u.toString());
      }
    } catch {
      /* malformed href — skip */
    }
  }
  return [...out];
}
