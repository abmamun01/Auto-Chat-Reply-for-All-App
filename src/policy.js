export const WEBSITE = 'https://fhitku.com';
export const DAY = 86400000;
const collaboration = /collab|colab|kolab|partnership|sponsor|influencer|ambassador|affiliate|promot|brand deal|business proposal|work together|কোলাব|কোল্যাব|পার্টনারশিপ|স্পনসর/i;
const sensitive = /complain|refund|return|cancel|broken|damag|fraud|scam|late|missing|wrong|problem|অভিযোগ|ফেরত|রিফান্ড|সমস্যা|ভুল|ভাঙা/i;
const takeover = /\b(stop|unsubscribe|human|agent|person|opt.?out)\b|মানুষ|বন্ধ করুন/i;
const verification = /ignore.*instructions|system prompt|confirm.*order|order.*confirm|\b(paid|payment|shipped|delivery|stock|available)\b|পেমেন্ট|ডেলিভারি|কনফার্ম|স্টক/i;
const price = /\b(price|prices|pricing|cost|dam|daam|koto|taka|tk|details)\b|দাম|মূল্য|কত|ডিটেইল/i;
const order = /\b(order|buy|kinbo|nibo|nite chai|kivabe kinbo)\b|অর্ডার|কিনব|নিবো|নিতে চাই/i;
const greeting = /^(hi|hello|hey|salam|assalamu ?alaikum|আসসালামু আলাইকুম|হাই|হ্যালো)[!.\s]*$/i;

// Conservative templates cost no AI tokens. Unknown/mixed intent stays with a human.
export function decide(event) {
  const text = event.text || '';
  if (event.human) return {reason: 'human_activity', pause: true};
  if (takeover.test(text)) return {reason: 'human_requested', pause: true};
  if (collaboration.test(text)) return {reason: 'collaboration', pause: true};
  if (sensitive.test(text)) return {reason: 'complaint', pause: true};
  if (verification.test(text)) return {reason: 'verification_required', pause: true};
  if (event.hasAttachment || !text || text.length > 2000) return {reason: 'needs_human', pause: true};
  if (price.test(text)) return {reason: 'price', reply: 'Price o details-er jonno please amader website visit korun: https://fhitku.com. Dhonnobad!'};
  if (order.test(text)) return {
    reason: 'order_request',
    reply: event.kind === 'comment'
      ? 'Order korte chaile amader inbox-e message din. Personal details comment-e diben na. Dhonnobad!'
      : 'Order request-er jonno product link, size/color, quantity, naam, phone o delivery address inbox-e din. Team details o terms verify kore order record korar por confirmation debe.',
    // Next private message is collected in the human inbox, never automatically confirmed.
    pauseAfter: event.kind === 'dm'
  };
  if (greeting.test(text)) return {reason: 'greeting', reply: 'Hello! Fhitku-te welcome 😊 Ki niye help lagbe? Product o price details: https://fhitku.com'};
  return {reason: 'needs_human', pause: true};
}

const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
export function normalize(payload, env, now = Date.now()) {
  const platform = payload.object === 'page' ? 'facebook' : payload.object === 'instagram' ? 'instagram' : null;
  if (!platform || !Array.isArray(payload.entry)) return [];
  const account = platform === 'facebook' ? env.FACEBOOK_PAGE_ID : env.INSTAGRAM_ACCOUNT_ID;
  const result = [];
  for (const entry of payload.entry) {
    if (!account || entry.id !== account) continue;
    for (const m of entry.messaging || []) {
      const msg = m.message;
      if (!msg || !id(msg.mid)) continue;
      const human = msg.is_echo === true;
      const actor = human ? m.recipient?.id : m.sender?.id;
      if (!id(actor) || actor === account || (!human && m.recipient?.id !== account)) continue;
      const at = m.timestamp;
      if (!Number.isFinite(at) || at > now + 60000 || now - at >= DAY) continue;
      result.push({platform, account, actor, kind: 'dm', id: msg.mid, at, human,
        text: typeof msg.text === 'string' ? msg.text.slice(0, 4000) : '', hasAttachment: !!msg.attachments?.length});
    }
    for (const change of entry.changes || []) {
      const c = change.value || {};
      if (platform === 'facebook' && (change.field !== 'feed' || c.item !== 'comment' || c.verb !== 'add')) continue;
      if (platform === 'instagram' && change.field !== 'comments') continue;
      const commentId = platform === 'facebook' ? c.comment_id : c.id;
      const actor = c.from?.id;
      // FB created_time is seconds. IG change payload often has only entry.time.
      const at = Number(c.created_time || entry.time) * 1000;
      if (!id(actor) || !id(commentId) || actor === account || !Number.isFinite(at) || at > now + 60000 || now - at >= DAY) continue;
      result.push({platform, account, actor, kind: 'comment', id: commentId, at,
        text: typeof (c.message ?? c.text) === 'string' ? (c.message ?? c.text).slice(0, 4000) : '',
        hasAttachment: !!(c.photo || c.video)});
    }
  }
  if (result.length > 100) throw new Error('batch_limit');
  return result;
}
