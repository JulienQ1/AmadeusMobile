import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisplayStream, extractUserName, finalizeReply, pauseAfter, processMemoryCommands } from '../src/chat/parse.ts';
import { searchMemories } from '../src/memory/rag.ts';

function drain(ds: DisplayStream) {
  const out: string[] = [];
  for (let it = ds.next(); it; it = ds.next()) out.push(it.kind === 'char' ? it.ch : it.kind === 'voice' ? `<${it.text}>` : `{${it.tag}}`);
  return out.join('');
}

test('stream: emotion tags become events, memory commands vanish, split tokens are handled', () => {
  const ds = new DisplayStream();
  for (const tok of ['[SM', 'ILE] Hel', 'lo. [BL', 'USH] Bye! [SAVE_', 'FACT: likes {"a":"]"} ramen]', ' <thi', 'nk>hidden</think>end']) ds.push(tok);
  ds.end();
  assert.equal(drain(ds), '{SMILE}Hello. {BLUSH}Bye! end');
});

test('stream: unknown brackets and angle brackets stay visible', () => {
  const ds = new DisplayStream();
  ds.push('Use [x] and a<b.');
  ds.end();
  assert.equal(drain(ds), 'Use [x] and a<b.');
});

test('final reply: memory commands parsed, tags removed', () => {
  const r = finalizeReply('<think>plan</think>[SMILE] Hi there! [SAVE_FACT: ユーザーの名前は「ジュリアン」] [SAVE_EVENT: {"summary":"First meeting","tags":["intro","lab"]}]');
  assert.equal(r.text, 'Hi there!');
  assert.equal(r.firstTag, 'SMILE');
  assert.deepEqual(r.facts, ['ユーザーの名前は「ジュリアン」']);
  assert.deepEqual(r.events, [{ summary: 'First meeting', tags: ['intro', 'lab'] }]);
  assert.equal(extractUserName(r.facts[0]), 'ジュリアン');
  assert.equal(extractUserName("The user's name is Julien"), 'Julien');
  assert.equal(finalizeReply('[SAVE_FACT: x]').text, '……');
});

test('memory command JSON may contain brackets', () => {
  const r = processMemoryCommands('ok [SAVE_EVENT: {"summary":"said [hi]","tags":"a,b"}]');
  assert.equal(r.cleaned, 'ok');
  assert.deepEqual(r.events, [{ summary: 'said [hi]', tags: ['a', 'b'] }]);
});

test('page breaks follow the original typewriter rules', () => {
  assert.equal(pauseAfter('そうね。', 'でも', false), true);
  assert.equal(pauseAfter('「そうね。', '」次', false), false);
  assert.equal(pauseAfter('「そうね。」', '次', false), true);
  assert.equal(pauseAfter('Hello.', ' World', false), true);
  assert.equal(pauseAfter('Dr.', ' Who', false), false);
  assert.equal(pauseAfter('Wait...', ' ok', false), false);
  assert.equal(pauseAfter('3.', '14', false), false);
  assert.equal(pauseAfter('Hello.', '', false), 'wait');
  assert.equal(pauseAfter('Hello.', '', true), true);
});

test('BM25 retrieves the relevant memory', () => {
  const docs = ['The user likes ramen', 'The user works at a lab', '[2026-09-01] Talked about time travel'];
  assert.deepEqual(searchMemories('what ramen should I eat', docs).slice(0, 1), ['The user likes ramen']);
  assert.deepEqual(searchMemories('タイムトラベル', ['タイムトラベルの話をした', '猫が好き']), ['タイムトラベルの話をした']);
});

test('moreText ignores trailing whitespace once the stream ended', () => {
  const ds = new DisplayStream();
  ds.push('Done? ');
  assert.equal(ds.moreText(), true);
  for (let i = 0; i < 5; i++) ds.next();
  assert.equal(ds.moreText(), null);
  ds.push('[SAVE_FACT: x]');
  ds.end();
  assert.equal(ds.moreText(), false);
});

test('stream: [VOICE: ...] lines become voice events, announced as soon as they close', () => {
  const ds = new DisplayStream();
  const early: string[] = [];
  ds.onVoice = (v) => early.push(v.text);
  const tokens = ['[SMUG] [VO', 'ICE: ふーん、やっと', '分かったのね。] Ah, tu as', ' compris. [VOICE：遅すぎるわよ。]', ' Il était temps.'];
  for (const tok of tokens) ds.push(tok);
  assert.deepEqual(early, ['ふーん、やっと分かったのね。', '遅すぎるわよ。']);
  ds.end();
  assert.equal(drain(ds), '{SMUG}<ふーん、やっと分かったのね。>Ah, tu as compris. <遅すぎるわよ。>Il était temps.');
});

test('final reply: voice lines are removed, an unterminated one included', () => {
  const r = finalizeReply('[NORMAL] [VOICE: こんにちは。] Bonjour. [VOICE: 元気？] Ça va ? [VOICE: 途中');
  assert.equal(r.text, 'Bonjour. Ça va ?');
  assert.equal(r.firstTag, 'NORMAL');
});

test('stream: transcript keeps voice lines in place, without emotion tags or memory commands', () => {
  const ds = new DisplayStream();
  ds.push('[SMUG] [VOICE: ふーん、] Hmm, [VOICE: やっと来たのね。] te voilà. [SAVE_FACT: x]');
  ds.end();
  assert.equal(ds.transcript(), '[VOICE: ふーん、] Hmm, [VOICE: やっと来たのね。] te voilà.');
});
