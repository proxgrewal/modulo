import { escapeHtml } from '@modulo/core';
import type { GenerateInput, LayoutModel } from './claude.ts';

/**
 * Deterministic, offline layout generator used when no API key is configured
 * (or the API fails). Picks sections from prompt keywords and fills copy from
 * the business type / name / place mentioned in the prompt. Emits the same
 * raw shape as the Claude adapter, so it goes through the same normaliser.
 */

interface Profile {
  noun: string;
  tagline: (name: string, place: string) => string;
  cta: string;
  features: { icon: string; title: string; text: string }[];
  quote: string;
  role: string;
}

const PROFILES: { match: RegExp; profile: Profile }[] = [
  {
    match: /\b(bakery|bakeries|patisserie|bread|pastr(y|ies)|cakes?)\b/i,
    profile: {
      noun: 'bakery',
      tagline: (n, p) => `Fresh bread and pastries baked every morning${p ? ` in ${p}` : ''} at ${n}.`,
      cta: 'See our menu',
      features: [
        { icon: '🥐', title: 'Baked fresh daily', text: 'Croissants, loaves and buns out of the oven before we open.' },
        { icon: '🎂', title: 'Custom cakes', text: 'Birthday, wedding and celebration cakes made to order.' },
        { icon: '🌾', title: 'Local ingredients', text: 'Flour, butter and eggs from farms near us.' },
      ],
      quote: 'The best sourdough in town — we stop by every Saturday.',
      role: 'Regular customer',
    },
  },
  {
    match: /\b(caf[eé]|coffee|espresso|roaster)\b/i,
    profile: {
      noun: 'café',
      tagline: (n, p) => `Specialty coffee and good company${p ? ` in ${p}` : ''} at ${n}.`,
      cta: 'Visit us',
      features: [
        { icon: '☕', title: 'Single-origin coffee', text: 'Beans roasted in small batches every week.' },
        { icon: '🥪', title: 'All-day food', text: 'Breakfast, lunch and sweet treats made in house.' },
        { icon: '📶', title: 'Work-friendly', text: 'Fast Wi-Fi, plenty of outlets and quiet corners.' },
      ],
      quote: 'My favourite place to start the day.',
      role: 'Local regular',
    },
  },
  {
    match: /\b(restaurant|bistro|diner|pizzeria|kitchen|eatery|food truck)\b/i,
    profile: {
      noun: 'restaurant',
      tagline: (n, p) => `Seasonal dishes and a warm welcome${p ? ` in ${p}` : ''} at ${n}.`,
      cta: 'Book a table',
      features: [
        { icon: '🍝', title: 'Seasonal menu', text: 'Dishes that change with what is fresh this week.' },
        { icon: '🍷', title: 'Curated drinks', text: 'Wines and cocktails picked to match the food.' },
        { icon: '🎉', title: 'Private events', text: 'Host your celebration in our private dining room.' },
      ],
      quote: 'Every visit feels like a special occasion.',
      role: 'Happy guest',
    },
  },
  {
    match: /\b(gym|fitness|yoga|pilates|crossfit|trainer|studio)\b/i,
    profile: {
      noun: 'studio',
      tagline: (n, p) => `Classes and coaching for every level${p ? ` in ${p}` : ''} at ${n}.`,
      cta: 'Book a free class',
      features: [
        { icon: '💪', title: 'Expert coaches', text: 'Certified trainers who tailor every session to you.' },
        { icon: '📅', title: 'Flexible schedule', text: 'Morning, lunchtime and evening classes all week.' },
        { icon: '🤝', title: 'Friendly community', text: 'Train alongside people who cheer you on.' },
      ],
      quote: 'I have never stuck with a routine this long. The coaches are fantastic.',
      role: 'Member since last year',
    },
  },
  {
    match: /\b(saas|software|app|platform|startup|api|tool)\b/i,
    profile: {
      noun: 'product',
      tagline: (n) => `${n} helps your team get more done with less busywork.`,
      cta: 'Start free trial',
      features: [
        { icon: '⚡', title: 'Fast setup', text: 'Up and running in minutes, no engineers required.' },
        { icon: '🔒', title: 'Secure by default', text: 'Encryption, SSO and audit logs on every plan.' },
        { icon: '📈', title: 'Actionable insights', text: 'Dashboards that show what is working at a glance.' },
      ],
      quote: 'We replaced three tools with this and our team is happier for it.',
      role: 'Head of Operations',
    },
  },
  {
    match: /\b(agency|consult(ing|ant|ancy)|studio|design|marketing|freelanc\w*)\b/i,
    profile: {
      noun: 'agency',
      tagline: (n) => `${n} turns ambitious ideas into work people remember.`,
      cta: 'Start a project',
      features: [
        { icon: '🎯', title: 'Strategy', text: 'Clear goals and a plan to reach them.' },
        { icon: '🎨', title: 'Design', text: 'Brands and websites crafted with care.' },
        { icon: '🚀', title: 'Launch', text: 'We ship, measure and keep improving.' },
      ],
      quote: 'They understood our business from the first meeting.',
      role: 'Founder',
    },
  },
  {
    match: /\b(photograph\w*|portfolio|artist|illustrat\w*)\b/i,
    profile: {
      noun: 'portfolio',
      tagline: (n) => `Selected work by ${n}.`,
      cta: 'Get in touch',
      features: [
        { icon: '📷', title: 'Portraits', text: 'Natural, relaxed portraits for people and teams.' },
        { icon: '🏞️', title: 'Events', text: 'Weddings, launches and everything in between.' },
        { icon: '🖼️', title: 'Prints', text: 'Fine-art prints available on request.' },
      ],
      quote: 'The photos captured the day perfectly.',
      role: 'Client',
    },
  },
];

const GENERIC: Profile = {
  noun: 'business',
  tagline: (n, p) => `${n} — quality service${p ? ` in ${p}` : ''} from people who care.`,
  cta: 'Get started',
  features: [
    { icon: '✦', title: 'Quality first', text: 'We take pride in doing things properly.' },
    { icon: '🤝', title: 'Personal service', text: 'Real people, quick answers, no runaround.' },
    { icon: '⭐', title: 'Trusted locally', text: 'Recommended by the customers we serve.' },
  ],
  quote: 'Professional, friendly and reliable. Highly recommended.',
  role: 'Customer',
};

type Section = 'hero' | 'features' | 'about' | 'gallery' | 'testimonial' | 'pricing' | 'faq' | 'contact';

const KEYWORDS: [Section, RegExp][] = [
  ['pricing', /\b(pricing|prices?|plans?|subscriptions?|packages?|tiers?)\b/i],
  ['faq', /\b(faqs?|questions|q&a)\b/i],
  ['testimonial', /\b(testimonials?|reviews?|quotes?|what (our )?customers say)\b/i],
  ['contact', /\b(contact|get in touch|reach us|location|address|visit|book(ing)?|call us|email)\b/i],
  ['gallery', /\b(gallery|photos?|images?|portfolio|showcase)\b/i],
  ['about', /\b(about|our story|story|team|mission|history)\b/i],
  ['features', /\b(features?|services?|benefits?|menu|offerings?|what we do)\b/i],
];

const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function analysePrompt(prompt: string) {
  const p = prompt.replace(/\s+/g, ' ').trim();
  const profile = PROFILES.find((x) => x.match.test(p))?.profile ?? GENERIC;
  const named = /\b(?:called|named)\s+["“']?([A-Za-z0-9&' .-]{2,40}?)["”']?(?=[,.;!?]|\s+(?:in|at|for|with|that|which|and)\b|$)/i.exec(p);
  const quoted = /["“]([^"”]{2,40})["”]/.exec(p);
  const place = /\b(?:in|based in|located in)\s+([A-Z][A-Za-z.-]+(?:\s+[A-Z][A-Za-z.-]+)?)/.exec(p)?.[1] ?? '';
  const forWhat = /\bfor\s+(?:a|an|my|our|the)?\s*([a-z][a-z -]{2,30}?)(?=[,.;!?]|\s+(?:called|named|in|with|that|which|and)\b|$)/i.exec(p)?.[1]?.trim();
  const name = (named?.[1] ?? quoted?.[1])?.trim() || (forWhat ? `The ${cap(forWhat)}` : `Your ${cap(profile.noun)}`);
  const wanted = KEYWORDS.filter(([, re]) => re.test(p)).map(([s]) => s);
  return { profile, name, place, wanted };
}

export class FallbackAdapter implements LayoutModel {
  async generate(input: GenerateInput): Promise<unknown> {
    const { profile, name, place, wanted } = analysePrompt(input.prompt);
    const builders: Record<Section, () => unknown> = {
      hero: () => ({ type: 'core:hero', props: { title: name, subtitle: profile.tagline(name, place), ctaLabel: profile.cta, ctaHref: '#contact', image: '' } }),
      features: () => ({ type: 'core:features', props: { items: profile.features } }),
      about: () =>
        section([
          heading(`About ${name}`),
          { type: 'core:text', props: { html: `<p>${escapeHtml(`${name} is a ${profile.noun}${place ? ` in ${place}` : ''} built around one idea: ${profile.tagline(name, place).replace(/\.$/, '').toLowerCase()}.`)}</p>` } },
        ]),
      gallery: () =>
        section([
          heading('Gallery'),
          { type: 'core:grid', props: { columns: 3, gap: 'token:space.md' }, children: [1, 2, 3].map((i) => ({ type: 'core:image', props: { src: '', alt: `${name} photo ${i}` } })) },
        ]),
      testimonial: () => ({ type: 'core:testimonial', props: { quote: profile.quote, author: 'A happy customer', role: profile.role } }),
      pricing: () => ({
        type: 'core:pricing',
        props: {
          plans: [
            { name: 'Starter', price: '$19', period: '/month', features: 'Everything to get started\nEmail support', ctaLabel: 'Choose Starter', ctaHref: '#contact', highlighted: false },
            { name: 'Pro', price: '$49', period: '/month', features: 'Everything in Starter\nPriority support\nAdvanced options', ctaLabel: 'Choose Pro', ctaHref: '#contact', highlighted: true },
            { name: 'Business', price: '$99', period: '/month', features: 'Everything in Pro\nDedicated manager', ctaLabel: 'Contact us', ctaHref: '#contact', highlighted: false },
          ],
        },
      }),
      faq: () => ({
        type: 'core:faq',
        props: {
          items: [
            { q: `Where is ${name}?`, a: place ? `We are in ${place}. Get in touch for directions.` : 'Get in touch and we will send directions.' },
            { q: 'What are your opening hours?', a: 'We are open Monday to Saturday. See the contact section for details.' },
            { q: 'How do I get in touch?', a: 'Use the contact section below — we usually reply within a day.' },
          ],
        },
      }),
      contact: () =>
        section([
          heading('Get in touch'),
          { type: 'core:text', props: { html: `<p>${escapeHtml(`Questions or orders? We would love to hear from you${place ? ` — or visit us in ${place}` : ''}.`)}</p>` } },
          { type: 'core:button', props: { label: profile.cta, href: 'mailto:hello@example.com', variant: 'primary' } },
        ]),
    };

    let order: Section[];
    if (input.mode === 'section') order = [wanted[0] ?? 'hero'];
    else {
      // A page always opens with a hero and the business's key features.
      const set = new Set<Section>(['hero', 'features', ...(wanted.length ? wanted : (['testimonial', 'contact'] as Section[]))]);
      const canonical: Section[] = ['hero', 'features', 'about', 'gallery', 'testimonial', 'pricing', 'faq', 'contact'];
      order = canonical.filter((s) => set.has(s));
    }
    const sections = order.flatMap((s, i) => (i > 0 && input.mode === 'page' && s === 'contact' ? [{ type: 'core:spacer', props: { size: 'token:space.lg' } }, builders[s]()] : [builders[s]()]));
    return { title: name, sections };
  }
}

function heading(text: string) {
  return { type: 'core:heading', props: { text, level: 'h2', align: 'center' } };
}

function section(children: unknown[]) {
  return { type: 'core:section', props: { tag: 'section' }, children: [{ type: 'core:stack', props: { direction: 'column', gap: 'token:space.md' }, children }] };
}
