import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

const controls = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const kinds = new Set(['music', 'control', 'custom']);
const responseStatuses = new Set(['pending', 'available', 'unavailable', 'ambiguous']);
const playerStates = new Set(['PLAYING', 'PAUSED', 'STOPPED', 'IDLE', 'FINISHED', 'UNKNOWN', 'BUFFERING']);
const invalidText = () => new AppError(400, 'INVALID_COMMAND', 'Enter a single-line command of 1 to 500 characters.');

export function normalizeCustomCommand(value) {
  if (typeof value !== 'string' || controls.test(value)) throw invalidText();
  const result = value.trim();
  if (!result || result.length > 500) throw invalidText();
  return result;
}
function metadata(value, max = 250) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || controls.test(value)) throw new AppError(400, 'INVALID_COMMAND_METADATA', 'The command’s device information is invalid.');
  return value.trim();
}
function visibleText(value, max = 500) {
  return typeof value === 'string' && !controls.test(value) ? value.trim().slice(0, max) : '';
}
const copyEntry = entry => entry ? { ...entry, observation: entry.observation ? { ...entry.observation } : null } : null;

export class CommandJournal {
  #entries = new Map();
  #lastTimestamp = 0;
  constructor({ clock = Date.now, max = 100 } = {}) {
    if (typeof clock !== 'function') throw new Error('Command journal clock required');
    this.clock = clock;
    this.max = Math.min(100, Math.max(1, Number.isInteger(max) ? max : 100));
  }
  #timestamp() {
    const value = this.clock();
    const now = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Date.now();
    this.#lastTimestamp = Math.max(now, this.#lastTimestamp + 1);
    return this.#lastTimestamp;
  }
  begin({ text, kind, deviceId = '', deviceName = '' } = {}) {
    const command = normalizeCustomCommand(text);
    if (!kinds.has(kind)) throw new AppError(400, 'INVALID_COMMAND_KIND', 'Choose a supported command type.');
    const device = metadata(deviceId), name = metadata(deviceName);
    const createdAt = this.#timestamp();
    const entry = { id: randomUUID(), text: command, kind, deviceId: device, deviceName: name, createdAt, updatedAt: createdAt, status: 'sending', message: 'Sending your command…', response: null, responseStatus: 'pending', observation: null };
    this.#entries.set(entry.id, entry);
    while (this.#entries.size > this.max) this.#entries.delete(this.#entries.keys().next().value);
    return copyEntry(entry);
  }
  #update(id, values) {
    const entry = typeof id === 'string' && this.#entries.get(id);
    if (!entry) return null;
    Object.assign(entry, values, { updatedAt: this.#timestamp() });
    return copyEntry(entry);
  }
  sent(id, message = 'Request sent to Alexa.') {
    if (!this.#entries.has(id)) return null;
    return this.#update(id, { status: 'sent', message: normalizeCustomCommand(message) });
  }
  failed(id, message = 'The command could not be sent.') {
    if (!this.#entries.has(id)) return null;
    return this.#update(id, { status: 'failed', message: normalizeCustomCommand(message), response: null, responseStatus: 'unavailable' });
  }
  response(id, text, { status = 'available' } = {}) {
    if (!this.#entries.has(id)) return null;
    if (!responseStatuses.has(status)) throw new AppError(400, 'INVALID_RESPONSE_STATUS', 'The Alexa response status is invalid.');
    // Only an independently matched response can be published as Alexa’s transcript.
    let response = null;
    if (status === 'available') response = normalizeCustomCommand(text);
    else if (text !== null && text !== undefined && typeof text !== 'string') throw new AppError(400, 'INVALID_COMMAND_RESPONSE', 'The Alexa response could not be read.');
    return this.#update(id, { response, responseStatus: status });
  }
  observe(id, player) {
    if (!this.#entries.has(id)) return null;
    let observation = null;
    if (player && typeof player === 'object' && !Array.isArray(player)) {
      const state = visibleText(player.state, 40).toUpperCase();
      observation = { state: playerStates.has(state) ? state : 'UNKNOWN', title: visibleText(player.title), artist: visibleText(player.artist), providerName: visibleText(player.providerName, 250) };
    }
    return this.#update(id, { observation });
  }
  list() { return [...this.#entries.values()].reverse().map(copyEntry); }
}
