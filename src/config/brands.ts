// Multi-brand config. Flip the whole generator between Misfit Ministries
// (faith content + merch) and Forge Mode (web-design ads + offers).
export type Brand = 'misfit' | 'forge';

export interface MerchCat { category: string; provider: string; providerUrl: string; cost: string; margin: string; }

export interface BrandConfig {
  id: Brand;
  name: string;
  emoji: string;
  storeContext: string;        // injected into every prompt
  postRole: string;            // who the AI is when writing posts
  postFocus: string;           // user-prompt guidance for posts
  postFallbackContent: string;
  postFallbackTags: string[];
  postFallbackImg: string;
  imageStyle: string;          // appended to post image prompts
  // second column: physical merch (misfit) OR ad/offer concepts (forge)
  merchLabel: string;
  merchRole: string;
  merchKind: string;           // "merchandise product" | "web-design ad concept"
  merchFocus: string;
  merchImageStyle: string;
  merchCategories: MerchCat[];
}

const MISFIT_CONTEXT = `
Misfit Ministries is a bold, authentic Christian ministry that reaches the broken, outcast, and those who don't feel like they fit in anywhere else.
The ministry believes everyone is loved by God — misfits, rebels, addicts, the hurting — all are welcome.
Tone: raw, real, bold, hopeful, street-savvy but full of grace. NOT corporate or bland.
Brand voice: passionate, genuine, urban-influenced, scripture-based, uplifting but never preachy.
`;

const FORGE_CONTEXT = `
Forge Mode is a one-person web design studio in Acadiana (Abbeville/Broussard, Louisiana) run by Dwayne Broussard.
It builds custom websites for local small businesses — live in about 24 hours, owned outright, no monthly fees, starting at $35.
Audience: local business owners (contractors, salons, restaurants, churches, shops), many burned by DIY/AI site builders or overpriced subscriptions.
Tone: confident, local, plain-spoken, a little swagger but trustworthy. Sell the outcome — a real site, fast, that you own.
Differentiators: 24-hour turnaround, you own it, free hosting, and a 24/7 AI "foreman" that answers when Dwayne can't. Call (337) 296-4793.
`;

export const BRANDS: Record<Brand, BrandConfig> = {
  misfit: {
    id: 'misfit', name: 'Misfit Ministries', emoji: '✝️',
    storeContext: MISFIT_CONTEXT,
    postRole: 'a social media strategist for Misfit Ministries',
    postFocus: `The post should feel authentic and reach people who feel like outcasts, addicts, the broken, or forgotten. Mix scripture, street-level honesty, and hope. Make it shareable.`,
    postFallbackContent: 'Misfit Ministries — You belong here. 🙌 #MisfitMinistries',
    postFallbackTags: ['#MisfitMinistries', '#BrokenAndBeautiful'],
    postFallbackImg: 'powerful faith-based ministry graphic, bold typography, cross, urban gritty hopeful style',
    imageStyle: 'ministry faith Christian bold graphic',
    merchLabel: 'Merch Ideas',
    merchRole: 'a merchandise designer for Misfit Ministries — a bold Christian outreach ministry for outcasts and broken people',
    merchKind: 'merchandise product',
    merchFocus: `Make it bold and wearable — something a real person would actually want to wear or use. Could have scripture, ministry logo, a powerful statement, or striking urban-faith design. Keep it fund-raising quality.`,
    merchImageStyle: 'clean white background, product photography, high quality',
    merchCategories: [
      { category: 'Hoodie', provider: 'Printful', providerUrl: 'https://www.printful.com', cost: '$18–22', margin: '60–80%' },
      { category: 'T-Shirt', provider: 'Printify', providerUrl: 'https://printify.com', cost: '$8–12', margin: '50–70%' },
      { category: 'Hat/Cap', provider: 'Printful', providerUrl: 'https://www.printful.com', cost: '$12–16', margin: '55–75%' },
      { category: 'Mug', provider: 'Printify', providerUrl: 'https://printify.com', cost: '$4–7', margin: '60–80%' },
      { category: 'Phone Case', provider: 'Printful', providerUrl: 'https://www.printful.com', cost: '$10–14', margin: '50–65%' },
      { category: 'Sticker Pack', provider: 'Sticker Mule', providerUrl: 'https://www.stickermule.com', cost: '$1–3', margin: '70–85%' },
      { category: 'Tote Bag', provider: 'Printify', providerUrl: 'https://printify.com', cost: '$8–12', margin: '55–70%' },
      { category: 'Poster', provider: 'Printful', providerUrl: 'https://www.printful.com', cost: '$6–10', margin: '60–75%' },
    ],
  },
  forge: {
    id: 'forge', name: 'Forge Mode', emoji: '🔨',
    storeContext: FORGE_CONTEXT,
    postRole: 'an advertising copywriter for Forge Mode web design',
    postFocus: `Write a scroll-stopping AD for Forge Mode. Pick an angle: before/after rebuild, the pain of $400 AI builders that don't deliver, the 24-hour turnaround, you-own-it / no monthly fees, the AI "foreman" that answers at 3am, or a local Acadiana business spotlight. End with a clear call to action: call (337) 296-4793 or DM.`,
    postFallbackContent: 'Burned by an AI site builder? I\'ll build you a real one in 24 hours — you own it, $35 to start. Call (337) 296-4793. 🔨',
    postFallbackTags: ['#ForgeMode', '#AcadianaBusiness', '#WebDesign'],
    postFallbackImg: 'sleek dark web design agency ad, device mockup of a modern website, bold ember-orange accents, professional',
    imageStyle: 'modern web design agency ad graphic, sleek dark UI mockup on a device, bold ember-orange accents, high contrast, professional',
    merchLabel: 'Ad / Offer Concepts',
    merchRole: 'an advertising creative director for Forge Mode web design',
    merchKind: 'web-design ad concept',
    merchFocus: `Create a Forge Mode AD CONCEPT (not a physical product) for this angle. The "title" is the hook, the "description" is the ad copy/idea, and "imagePrompt" is the visual to generate for the ad. Make it convert local business owners.`,
    merchImageStyle: 'web design advertisement visual, sleek device mockups, bold ember-orange brand accents, professional marketing graphic',
    merchCategories: [
      { category: 'Before / After Rebuild', provider: 'Forge Mode', providerUrl: 'tel:13372964793', cost: 'Spark — $35', margin: 'High intent' },
      { category: 'Pain-Hook Ad ($400 builders)', provider: 'Forge Mode', providerUrl: 'tel:13372964793', cost: 'Draft — $80', margin: 'High intent' },
      { category: 'The Foreman Flex (24/7 AI)', provider: 'Forge Mode', providerUrl: 'tel:13372964793', cost: 'Build — $125', margin: 'Differentiator' },
      { category: 'You Own It / No Monthly', provider: 'Forge Mode', providerUrl: 'tel:13372964793', cost: 'Operator — $170', margin: 'Trust' },
      { category: 'Local Acadiana Spotlight', provider: 'Forge Mode', providerUrl: 'tel:13372964793', cost: 'Flagship — $215', margin: 'Local reach' },
      { category: '24-Hour Turnaround', provider: 'Forge Mode', providerUrl: 'tel:13372964793', cost: 'Any tier', margin: 'Urgency' },
    ],
  },
};

// ---- Auto-alternating schedule (no manual switch) ----
// Misfit Ministries owns 8 AM–8 PM; Forge Mode owns 8 PM–8 AM.
export function brandForHour(hour: number): Brand {
  return hour >= 8 && hour < 20 ? 'misfit' : 'forge';
}
// Current brand based on Central time (Acadiana).
export function currentBrand(d: Date = new Date()): Brand {
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(d)) % 24;
  return brandForHour(h);
}
// When does the active window flip, and to what?
export function nextSwitch(d: Date = new Date()): { at: string; to: Brand } {
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(d)) % 24;
  const toForge = h >= 8 && h < 20;
  return { at: toForge ? '8 PM' : '8 AM', to: toForge ? 'forge' : 'misfit' };
}
