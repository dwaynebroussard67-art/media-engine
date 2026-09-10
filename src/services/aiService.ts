import { v4 as uuidv4 } from 'uuid';
import { BRANDS, type Brand } from '../config/brands';
import { useStore } from '../store/useStore';
import type { GalleryImage, SocialPost, MerchandiseIdea, PostBatch, PostPlatform } from '../store/useStore';

const POLLINATIONS_IMAGE = 'https://image.pollinations.ai/prompt';
const POLLINATIONS_TEXT = 'https://text.pollinations.ai/openai';

// Ministry context injected into every prompt
const PLATFORMS: PostPlatform[] = ['TikTok', 'Facebook', 'Instagram', 'Twitter'];

const PLATFORM_SPECS: Record<PostPlatform, { charLimit: number; style: string; aspect: string }> = {
  TikTok: { charLimit: 150, style: 'Short, punchy, trending. Use 3–5 hashtags. Great for young audiences. Hook in first 3 words.', aspect: '9:16' },
  Facebook: { charLimit: 300, style: 'Conversational, story-driven, community-focused. Share a thought or testimony excerpt. 2–3 hashtags.', aspect: '1:1' },
  Instagram: { charLimit: 200, style: 'Visual-first, inspirational quote or snippet. 5–7 hashtags at end. Emojis are fine.', aspect: '1:1' },
  Twitter: { charLimit: 280, style: 'Punchy one-liner or bold scripture. Max 280 chars including 2 hashtags.', aspect: '16:9' },
};

async function callTextAPI(systemPrompt: string, userPrompt: string): Promise<string> {
  try {
    const response = await fetch(POLLINATIONS_TEXT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.85,
        max_tokens: 600,
      }),
    });
    const data = await response.json();
    return data?.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    console.error('Text API error:', e);
    return '';
  }
}

function buildImageUrl(prompt: string, width = 1024, height = 1024, seed?: number): string {
  const encoded = encodeURIComponent(prompt);
  const s = seed ?? Math.floor(Math.random() * 99999);
  return `${POLLINATIONS_IMAGE}/${encoded}?width=${width}&height=${height}&seed=${s}&model=flux&nologo=true`;
}

async function generateSocialPost(
  platform: PostPlatform,
  galleryImages: GalleryImage[],
  batchId: string,
  brand: Brand = 'misfit'
): Promise<SocialPost> {
  const b = BRANDS[brand];
  const spec = PLATFORM_SPECS[platform];
  const imgRef = galleryImages.length > 0
    ? `Reference this image description for context: a strong on-brand image from the ${b.name} gallery.`
    : '';

  const systemPrompt = `You are ${b.postRole}. ${b.storeContext}
Your job: write a single ${platform} post. ${spec.style}
Character limit: ${spec.charLimit} characters (not counting hashtags for TikTok/Instagram).
Return ONLY valid JSON in this exact format:
{
  "content": "the post text here",
  "hashtags": ["hashtag1", "hashtag2"],
  "imagePrompt": "a detailed AI image prompt for a ${platform} post visual"
}`;

  const taste = useStore.getState().getTasteDirective(brand);
  const userPrompt = `Write a ${platform} post for ${b.name}. ${imgRef}
${b.postFocus}${taste}`;

  let parsed: { content: string; hashtags: string[]; imagePrompt: string } = {
    content: b.postFallbackContent,
    hashtags: b.postFallbackTags,
    imagePrompt: b.postFallbackImg,
  };

  try {
    const raw = await callTextAPI(systemPrompt, userPrompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn('Post parse error, using fallback');
  }

  const imageUrl = buildImageUrl(
    `${parsed.imagePrompt}, ${b.imageStyle}, ${platform} social media post`,
    platform === 'TikTok' ? 720 : 1080,
    platform === 'TikTok' ? 1280 : 1080
  );

  return {
    id: uuidv4(), platform, content: parsed.content, imagePrompt: parsed.imagePrompt,
    imageUrl, hashtags: parsed.hashtags, status: 'pending', generatedAt: Date.now(), batchId,
  };
}

async function generateMerchandiseIdea(batchId: string, brand: Brand = 'misfit'): Promise<MerchandiseIdea> {
  const b = BRANDS[brand];
  const merch = b.merchCategories[Math.floor(Math.random() * b.merchCategories.length)];

  const systemPrompt = `You are ${b.merchRole}. ${b.storeContext}
Design a ${b.merchKind} in the "${merch.category}" lane.
Return ONLY valid JSON in this exact format:
{
  "title": "title / hook",
  "description": "description of the concept",
  "imagePrompt": "detailed prompt to generate the visual"
}`;

  const taste = useStore.getState().getTasteDirective(brand);
  const userPrompt = `Create a "${merch.category}" ${b.merchKind} for ${b.name}.
${b.merchFocus}${taste}`;

  let parsed = {
    title: `${b.name} — ${merch.category}`,
    description: `${merch.category} concept for ${b.name}.`,
    imagePrompt: `${merch.category} concept, ${b.merchImageStyle}`,
  };

  try {
    const raw = await callTextAPI(systemPrompt, userPrompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn('Merch parse error, using fallback');
  }

  const imageUrl = buildImageUrl(`${parsed.imagePrompt}, ${b.merchImageStyle}`, 1024, 1024);

  return {
    id: uuidv4(), title: parsed.title, description: parsed.description, imagePrompt: parsed.imagePrompt,
    imageUrl, category: merch.category, estimatedCost: merch.cost, printProvider: merch.provider,
    printProviderUrl: merch.providerUrl, profitMargin: merch.margin, status: 'pending',
    generatedAt: Date.now(), batchId,
  };
}

export async function generateBatch(galleryImages: GalleryImage[], hourSlot: number, brand: Brand = 'misfit'): Promise<PostBatch> {
  const batchId = uuidv4();
  const now = Date.now();
  const [posts, merchandise] = await Promise.all([
    Promise.all(PLATFORMS.map((p) => generateSocialPost(p, galleryImages, batchId, brand))),
    Promise.all([
      generateMerchandiseIdea(batchId, brand),
      generateMerchandiseIdea(batchId, brand),
      generateMerchandiseIdea(batchId, brand),
      generateMerchandiseIdea(batchId, brand),
    ]),
  ]);
  return { id: batchId, generatedAt: now, scheduledFor: now, posts, merchandise, alertSent: true, hourSlot };
}

export async function remixPost(
  post: SocialPost,
  _galleryImages: GalleryImage[],
  remixNotes: string
): Promise<SocialPost> {
  const spec = PLATFORM_SPECS[post.platform];

  const b = BRANDS[useStore.getState().brand];
  const systemPrompt = `You are ${b.postRole}. ${b.storeContext}
You are remixing an existing ${post.platform} post based on feedback.
Return ONLY valid JSON:
{
  "content": "remixed post text",
  "hashtags": ["hashtag1", "hashtag2"],
  "imagePrompt": "new image prompt"
}`;

  const userPrompt = `Original post: "${post.content}"
Remix feedback: "${remixNotes}"
Platform: ${post.platform}. ${spec.style}
Keep the ${b.name} voice. Improve based on feedback.`;

  let parsed = {
    content: post.content + ' (remixed)',
    hashtags: post.hashtags,
    imagePrompt: post.imagePrompt + ', remixed version',
  };

  try {
    const raw = await callTextAPI(systemPrompt, userPrompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('Remix parse error');
  }

  const imageUrl = buildImageUrl(
    `${parsed.imagePrompt}, ${b.imageStyle}`,
    1024,
    1024,
    Math.floor(Math.random() * 99999)
  );

  return {
    ...post,
    content: parsed.content,
    hashtags: parsed.hashtags,
    imagePrompt: parsed.imagePrompt,
    imageUrl,
    status: 'pending',
    remixNotes,
  };
}

export async function remixMerchandise(
  item: MerchandiseIdea,
  remixNotes: string
): Promise<MerchandiseIdea> {
  const b = BRANDS[useStore.getState().brand];
  const systemPrompt = `You are ${b.merchRole}. ${b.storeContext}
Remix this concept based on feedback.
Return ONLY valid JSON:
{
  "title": "new product title",
  "description": "new description",
  "imagePrompt": "new image prompt"
}`;

  const userPrompt = `Original: "${item.title}" — ${item.description}
Remix feedback: "${remixNotes}"
Keep it for ${item.category}. Make it better.`;

  let parsed = {
    title: item.title + ' (remix)',
    description: item.description,
    imagePrompt: item.imagePrompt,
  };

  try {
    const raw = await callTextAPI(systemPrompt, userPrompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('Remix merch parse error');
  }

  const imageUrl = buildImageUrl(
    `${parsed.imagePrompt}, clean white background, product photography`,
    1024,
    1024,
    Math.floor(Math.random() * 99999)
  );

  return {
    ...item,
    title: parsed.title,
    description: parsed.description,
    imagePrompt: parsed.imagePrompt,
    imageUrl,
    status: 'pending',
    remixNotes,
  };
}
