/* global */
/**
 * Zoowan — shared action definitions.
 * Loaded both by the background event page and every content script,
 * so toolbar labels/icons (content) and prompts (background) stay in sync.
 */

const LG_ACTIONS = {
  rephrase: {
    label: 'Rephrase',
    icon: '🔄',
    userLead: 'Rephrase this text:',
    system: [
      'You are a skilled editor and writer.',
      "Rephrase the user's text: express the same idea with different wording while keeping the meaning, tone, and approximate length intact.",
      'Do not add new information or remove existing points.'
    ].join(' ')
  },
  formal: {
    label: 'Make it formal',
    icon: '🎩',
    userLead: 'Rewrite this text in a formal register:',
    system: [
      "Rewrite the user's text in a formal, professional register suitable for business emails, reports, or official correspondence.",
      'Use precise vocabulary and complete sentences. Avoid contractions, slang, idioms, and filler words.',
      'Keep the original meaning and every key detail.'
    ].join(' ')
  },
  informal: {
    label: 'Make it informal',
    icon: '😎',
    userLead: 'Rewrite this text in a casual tone:',
    system: [
      "Rewrite the user's text in a casual, friendly, conversational tone, as if writing to a friend.",
      'Contractions and natural phrasing are welcome.',
      'Keep the original meaning and every key detail intact.'
    ].join(' ')
  },
  correct: {
    label: 'Correct mistakes',
    icon: '✅',
    userLead: 'Proofread and fix this text:',
    system: [
      "Proofread the user's text and fix errors in grammar, spelling, punctuation, capitalization, and word choice.",
      'Make the smallest changes necessary: do not rephrase or restructure sentences that are already correct.',
      "Preserve the author's voice, tone, emphasis, and formatting (including line breaks).",
      'If there are no mistakes, return the text unchanged.'
    ].join(' ')
  },
  shorten: {
    label: 'Shorten',
    icon: '✂️',
    userLead: 'Condense this text:',
    system: [
      "Condense the user's text so it is significantly shorter and more direct.",
      'Preserve all essential information and the original meaning.',
      'Remove redundancy, filler words, and unnecessary qualifiers.'
    ].join(' ')
  }
};

const LG_ACTION_ORDER = ['rephrase', 'formal', 'informal', 'correct', 'shorten'];

/** Rules appended to every system prompt so the model returns clean, replaceable text. */
const LG_COMMON_RULES = [
  'Respond with ONLY the final text.',
  'Do not wrap it in quotes or code blocks and do not use bullet points unless the input used them.',
  'Do not add explanations, labels, prefixes (like "Here is..."), or any commentary.',
  'Preserve the original language of the input text.'
].join(' ');

/** Build the chat messages for an action. */
function lgBuildMessages(actionKey, text) {
  const action = LG_ACTIONS[actionKey];
  if (!action) throw new Error('Unknown action: ' + actionKey);
  return [
    { role: 'system', content: action.system + '\n\n' + LG_COMMON_RULES },
    { role: 'user', content: action.userLead + '\n"""\n' + text + '\n"""' }
  ];
}

/** Build messages for a user-supplied custom prompt applied to the selected text.
 *  The instruction is sent verbatim; the selection is wrapped in """ delimiters so
 *  local models can reliably tell instruction apart from payload. */
function lgBuildCustomMessages(prompt, text, cleanOutput) {
  const system = [
    "You are an expert assistant working on the user's selected text.",
    'Apply the instruction below exactly to the provided text.',
    cleanOutput ? LG_COMMON_RULES : 'Keep the answer concise and directly useful.'
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: 'Instruction:\n' + prompt + '\n\nText to apply it to:\n"""\n' + text + '\n"""' }
  ];
}
