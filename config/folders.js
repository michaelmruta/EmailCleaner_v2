'use strict';

const YAHOO_FOLDERS = [
  '_Important', 'BDO AMEX', 'BDO Online', 'Conversation History',
  'Documents', 'Eleve', 'Facebook', 'GCash', 'Globe', 'Grab', 'iTunes', 'Maya', 'Meralco',
  'Netflix', 'PLDT', 'Shopping', 'Twitter', 'Uchu Neko', 'UnionBank',
];

// ── Exact domain → folder ──────────────────────────────────────────────────
const DOMAIN_RULES = {
  // Shopping / E-commerce
  'shopee.ph': 'Shopping',        'shopee.com': 'Shopping',
  'lazada.com.ph': 'Shopping',    'lazada.com': 'Shopping',
  'zalora.com.ph': 'Shopping',    'zalora.com': 'Shopping',
  'amazon.com': 'Shopping',       'amazon.com.ph': 'Shopping',
  'ebay.com': 'Shopping',         'shein.com': 'Shopping',
  'temu.com': 'Shopping',         'carousell.ph': 'Shopping',
  'carousell.com': 'Shopping',    'h&m.com': 'Shopping',
  'uniqlo.com': 'Shopping',       'zara.com': 'Shopping',
  'asos.com': 'Shopping',         'aliexpress.com': 'Shopping',

  // Grab
  'grab.com': 'Grab',             'grabtaxi.com': 'Grab',
  'grabfood.com': 'Grab',         'help.grab.com': 'Grab',

  // Meralco
  'meralco.com.ph': 'Meralco',    'meralco.ph': 'Meralco',

  // PLDT / Converge
  'pldt.com.ph': 'PLDT',          'pldthome.net': 'PLDT',
  'pldt.com': 'PLDT',             'mydsl.com.ph': 'PLDT',
  'convergeict.com': 'PLDT',      'skycable.com': 'PLDT',

  // UnionBank
  'unionbankph.com': 'UnionBank', 'unionbank.com.ph': 'UnionBank',
  'eunionbank.com': 'UnionBank',  'ubx.ph': 'UnionBank',

  // Netflix / Streaming
  'netflix.com': 'Netflix',

  // Social
  'facebookmail.com': 'Facebook', 'fb.com': 'Facebook',
  'instagram.com': 'Facebook',    'meta.com': 'Facebook',
  'twitter.com': 'Twitter',       'twittermail.com': 'Twitter',
  'x.com': 'Twitter',

  // Apple / iTunes
  'apple.com': 'iTunes',          'itunes.com': 'iTunes',
  'email.apple.com': 'iTunes',    'appleid.apple.com': 'iTunes',

  // Eleve / First Georgetown Ventures (condo)
  'firstgeorgetownventures.com': 'Eleve',
  'eleve.com.ph': 'Eleve',
  'fgv.com.ph': 'Eleve',

  // ── DELETE: Job sites ──────────────────────────────────────────────────
  'linkedin.com': 'DELETE',
  'notifications.linkedin.com': 'DELETE',
  'glassdoor.com': 'DELETE',
  'jobstreet.com.ph': 'DELETE',
  'kalibrr.com': 'DELETE',
  'indeed.com': 'DELETE',
  'jobsdb.com': 'DELETE',

  // DELETE: Newsletters / promos known aggressive senders
  'marketing.lazada.com': 'DELETE',
  'email.shopee.ph': 'DELETE',        // Shopee promo blasts (keep transactional shopee.ph)
  'deals.amazon.com': 'DELETE',
  'payments-messages.amazon.com': 'Shopping', // but receipts go to Shopping
  'noreply.github.com': 'DELETE',
  'github.com': 'DELETE',

  // Globe (kept — own folder)
  'globe.com.ph': 'Globe',           'globetelecom.com': 'Globe',

  // GCash (kept — own folder)
  'gcash.com': 'GCash',

  // Maya (kept — own folder)
  'maya.ph': 'Maya',                 'paymaya.com': 'Maya',

  // DELETE: Philippine promos
  'smart.com.ph': 'DELETE',          'tnt.com.ph': 'DELETE',
  'sun.com.ph': 'DELETE',            'dito.ph': 'DELETE',
  'coins.ph': 'DELETE',
};

// ── BDO routing: AMEX credit card vs Online banking ────────────────────────
const BDO_DOMAINS = ['bdo.com.ph', 'bdo.unibank.com', 'bdo.ph'];
const BDO_AMEX_KEYWORDS = [
  'amex', 'american express', 'credit card', 'statement of account',
  'cashback', 'rewards points', 'points earned', 'payment due',
  'minimum payment', 'available credit', 'card ending',
];

// ── Sender name / from address keyword rules (lowercased partial match) ────
const KEYWORD_RULES = [
  // Utilities
  { match: ['meralco'],                                   folder: 'Meralco' },
  { match: ['pldt', 'fibr', 'pldthome', 'converge ict'], folder: 'PLDT' },
  // Banking
  { match: ['unionbank', 'union bank'],                   folder: 'UnionBank' },
  { match: ['bpi ', 'bank of the philippine islands'],    folder: '_Important' },
  { match: ['metrobank', 'metro bank'],                   folder: '_Important' },
  { match: ['rcbc', 'rizal commercial'],                  folder: '_Important' },
  { match: ['security bank'],                             folder: '_Important' },
  { match: ['landbank', 'land bank'],                     folder: '_Important' },
  { match: ['pnb ', 'philippine national bank'],          folder: '_Important' },
  { match: ['chinabank', 'china bank'],                   folder: '_Important' },
  { match: ['eastwest bank', 'ewbank'],                   folder: '_Important' },
  { match: ['citibank', 'citi bank'],                     folder: '_Important' },
  { match: ['maybank'],                                   folder: '_Important' },
  // Transport / delivery
  { match: ['grab', 'grabfood', 'grabpay', 'grabtaxi'],  folder: 'Grab' },
  { match: ['lbc express', 'lbc courier'],                folder: 'Documents' },
  { match: ['j&t express', 'jt express', 'ninjavan', 'flash express', 'borzo'], folder: 'Shopping' },
  // E-commerce
  { match: ['shopee'],                                    folder: 'Shopping' },
  { match: ['lazada'],                                    folder: 'Shopping' },
  { match: ['zalora'],                                    folder: 'Shopping' },
  { match: ['amazon'],                                    folder: 'Shopping' },
  { match: ['shein', 'temu', 'carousell'],                folder: 'Shopping' },
  // Streaming
  { match: ['netflix'],                                   folder: 'Netflix' },
  { match: ['spotify'],                                   folder: 'DELETE' },
  { match: ['youtube premium', 'youtube music'],          folder: 'DELETE' },
  { match: ['disney+', 'disneyplus', 'disney plus'],     folder: 'DELETE' },
  // Apple
  { match: ['apple', 'itunes', 'app store', 'appstore'], folder: 'iTunes' },
  // Social
  { match: ['facebook', 'instagram', 'meta platforms', 'meta inc'], folder: 'Facebook' },
  { match: ['twitter', '@x.com', 'x corp'],              folder: 'Twitter' },
  { match: ['tiktok'],                                    folder: 'DELETE' },
  // Eleve / condo
  { match: ['eleve', 'first georgetown', 'georgetown ventures', 'fgv'], folder: 'Eleve' },
  // Own company
  { match: ['uchu neko', 'ucheneko', 'uchunet'],         folder: 'Uchu Neko' },
  // Government PH
  { match: ['sss ', 'social security system'],            folder: 'Documents' },
  { match: ['philhealth'],                                folder: 'Documents' },
  { match: ['pag-ibig', 'pagibig', 'hdmf'],              folder: 'Documents' },
  { match: ['bir ', 'bureau of internal revenue'],       folder: 'Documents' },
  // Travel
  { match: ['cebu pacific', 'cebupacific'],               folder: '_Important' },
  { match: ['airasia', 'air asia'],                       folder: '_Important' },
  { match: ['philippine airlines', 'pal '],               folder: '_Important' },
  { match: ['agoda', 'booking.com', 'airbnb'],            folder: '_Important' },
  // Globe (kept — own folder)
  { match: ['globe telecom', 'globe broadband', 'gosurf', 'gosakto', 'goglobe'], folder: 'Globe' },
  // DELETE: telecom promos
  { match: ['smart communications', 'smart bro', 'talk n text', 'tnt '], folder: 'DELETE' },
  { match: ['dito telecommunity', 'dito sim'],            folder: 'DELETE' },
  // GCash (kept — own folder)
  { match: ['gcash', 'g-cash'],                           folder: 'GCash' },
  // Maya (kept — own folder)
  { match: ['paymaya', 'maya wallet', 'maya bank', 'maya ph'], folder: 'Maya' },
  // DELETE: digital wallets (mostly OTPs/promos)
  { match: ['coins.ph', 'coinsph'],                       folder: 'DELETE' },
  // DELETE: marketing platforms (if not caught by header rules)
  { match: ['via sendgrid', 'via mailchimp', 'via klaviyo'], folder: 'DELETE' },
];

// ── Known marketing platform mailers (x-mailer / x-sender-id header) ──────
const MARKETING_MAILERS = [
  'mailchimp', 'klaviyo', 'sendgrid', 'brevo', 'sendinblue',
  'constant contact', 'campaignmonitor', 'campaign monitor',
  'hubspot', 'marketo', 'salesforce marketing', 'eloqua',
  'activecampaign', 'mailgun', 'postmark', 'sparkpost', 'mandrill',
  'iterable', 'customerio', 'customer.io', 'omnisend', 'drip',
  'getresponse', 'aweber', 'convertkit',
];

// ── Subject regex rules ────────────────────────────────────────────────────
// Checked in order. 'keep' prevents delete from header/other signals.
const SUBJECT_RULES = [
  // ── KEEP (high-value transactional — checked FIRST) ──────────────────
  { re: /order\s*(confirmed|placed|received|shipped|out for delivery|delivered)/i, action: 'move', folder: 'Shopping' },
  { re: /(payment|purchase)\s*(receipt|confirmation|successful)/i,                action: 'move', folder: 'Shopping' },
  { re: /your\s*(invoice|official receipt|OR\b)/i,                                action: 'move', folder: 'Documents' },
  { re: /statement\s*of\s*account/i,                                              action: 'move', folder: 'BDO Online' },
  { re: /(bill|billing)\s*(statement|summary|notice|due|is\s*ready)/i,           action: 'move', folder: 'Documents' },
  { re: /booking\s*(confirmed|confirmation|reference)/i,                          action: 'move', folder: '_Important' },
  { re: /e-?ticket|flight\s*(confirmation|itinerary)/i,                           action: 'move', folder: '_Important' },
  { re: /password\s*(reset|changed|updated)/i,                                    action: 'move', folder: '_Important' },
  { re: /account\s*(suspended|locked|compromised|alert|update required)/i,        action: 'move', folder: '_Important' },
  { re: /contract|deed\s*of\s*sale|turn.?over|move.?in|unit\s*(acceptance|turnover)/i, action: 'move', folder: 'Eleve' },

  // ── DELETE (promotional / noise) ─────────────────────────────────────
  { re: /\b\d+%\s*off\b/i,                              action: 'delete', reason: 'discount promo' },
  { re: /flash\s*sale/i,                                action: 'delete', reason: 'flash sale' },
  { re: /mega\s*(sale|deals?)/i,                        action: 'delete', reason: 'mega sale' },
  { re: /\bsale\s*(ends?|alert|today|now|live)\b/i,     action: 'delete', reason: 'sale notification' },
  { re: /\b(exclusive|special)\s*(offer|deal|promo)\b/i, action: 'delete', reason: 'exclusive offer' },
  { re: /limited[\s-]time\s*(offer|only|deal)/i,        action: 'delete', reason: 'limited time' },
  { re: /don'?t\s*miss\s*(out|this)/i,                  action: 'delete', reason: 'fomo marketing' },
  { re: /\bhurry[\s!]|act\s*now[\s!]|today\s*only[\s!]/i, action: 'delete', reason: 'urgency marketing' },
  { re: /free\s*shipping\s*on/i,                        action: 'delete', reason: 'free shipping promo' },
  { re: /\bpromo\s*code\b|\bvoucher\s*code\b|\bdiscount\s*code\b/i, action: 'delete', reason: 'promo code' },
  { re: /\bearn\s*\d+\s*(points?|coins?|cashback)\b/i,  action: 'delete', reason: 'points earning promo' },
  { re: /\bunsubscribe\b|\bnewsletter\b/i,              action: 'delete', reason: 'newsletter' },
  { re: /\byour\s*(weekly|monthly|daily)\s*(digest|summary|roundup|update)\b/i, action: 'delete', reason: 'digest newsletter' },
  { re: /\b(otp|one.time.password|one.time.pin)\b/i,   action: 'delete', reason: 'OTP - expired' },
  { re: /\bverification\s*code\b|\baccess\s*code\b|\bconfirmation\s*code\b/i, action: 'delete', reason: 'verification code' },
  { re: /liked\s*your\s*(post|photo|comment|story)/i,   action: 'delete', reason: 'social like notification' },
  { re: /commented\s*on\s*your|replied\s*to\s*your/i,   action: 'delete', reason: 'social comment notification' },
  { re: /wants\s*to\s*connect|sent\s*you\s*a\s*(message|request|invite)/i, action: 'delete', reason: 'social connection' },
  { re: /you\s*have\s*\d+\s*new\s*(notification|message|friend)/i, action: 'delete', reason: 'social notification' },
  { re: /\bfollow(ed|s)\s*you\b/i,                     action: 'delete', reason: 'social follow notification' },
  { re: /tagged\s*you\s*in/i,                           action: 'delete', reason: 'social tag notification' },
];

// ── Helper: extract domain from email address ──────────────────────────────
function extractDomain(email) {
  if (!email) return '';
  const m = email.match(/@([\w.-]+)/);
  return m ? m[1].toLowerCase() : '';
}

// ── Main classifier ────────────────────────────────────────────────────────
function classifyByRules(email) {
  const { from = '', fromName = '', subject = '', headers = {} } = email;
  const domain      = extractDomain(from);
  const fromLower   = `${from} ${fromName}`.toLowerCase();
  const subjectLower = subject.toLowerCase();

  // 1. Subject KEEP rules (checked first — protect transactional emails)
  for (const rule of SUBJECT_RULES) {
    if (rule.action === 'move' && rule.re.test(subject)) {
      // Still verify against known domains for precision
      return { action: 'move', folder: rule.folder, source: 'rule:subject-keep' };
    }
  }

  // 2. Header signals — strongest DELETE signal (newsletters/bulk)
  if (headers.listUnsubscribe) {
    // But don't delete if it's from a known important domain
    if (!DOMAIN_RULES[domain] || DOMAIN_RULES[domain] === 'DELETE') {
      return { action: 'delete', reason: 'List-Unsubscribe header (newsletter)', source: 'rule:header' };
    }
  }
  if (headers.precedence === 'bulk' || headers.precedence === 'list') {
    if (!DOMAIN_RULES[domain] || DOMAIN_RULES[domain] === 'DELETE') {
      return { action: 'delete', reason: `Precedence: ${headers.precedence}`, source: 'rule:header' };
    }
  }
  if (headers.xMailer) {
    const mailer = headers.xMailer.toLowerCase();
    if (MARKETING_MAILERS.some(m => mailer.includes(m))) {
      return { action: 'delete', reason: `Marketing mailer: ${headers.xMailer}`, source: 'rule:header' };
    }
  }
  if (headers.hasCampaignId) {
    return { action: 'delete', reason: 'Marketing campaign ID in headers', source: 'rule:header' };
  }

  // 3. BDO special routing
  if (BDO_DOMAINS.some(d => domain === d) || fromLower.includes('bdo unibank') || fromLower.includes('bdo network bank')) {
    const isAmex = BDO_AMEX_KEYWORDS.some(k => subjectLower.includes(k));
    return { action: 'move', folder: isAmex ? 'BDO AMEX' : 'BDO Online', source: 'rule:domain-bdo' };
  }

  // 4. Exact domain match
  if (DOMAIN_RULES[domain]) {
    const target = DOMAIN_RULES[domain];
    if (target === 'DELETE') return { action: 'delete', reason: 'domain blocklist', source: 'rule:domain' };
    return { action: 'move', folder: target, source: 'rule:domain' };
  }

  // 5. Sender keyword match
  for (const rule of KEYWORD_RULES) {
    if (rule.match.some(k => fromLower.includes(k))) {
      if (rule.folder === 'DELETE') return { action: 'delete', reason: 'sender keyword', source: 'rule:keyword' };
      return { action: 'move', folder: rule.folder, source: 'rule:keyword' };
    }
  }

  // 6. Subject DELETE patterns
  for (const rule of SUBJECT_RULES) {
    if (rule.action === 'delete' && rule.re.test(subject)) {
      return { action: 'delete', reason: rule.reason, source: 'rule:subject-delete' };
    }
  }

  // 7. Needs LLM
  return null;
}

module.exports = { YAHOO_FOLDERS, DOMAIN_RULES, KEYWORD_RULES, SUBJECT_RULES, MARKETING_MAILERS, classifyByRules, extractDomain, BDO_AMEX_KEYWORDS };
