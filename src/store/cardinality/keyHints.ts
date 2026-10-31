// SPDX-License-Identifier: Apache-2.0
// Remediation hints for attribute keys known to carry high-cardinality values, and per value class.
// Based on OpenTelemetry semantic conventions. Pure; no vscode import.

import { ValueClass } from './valueClass';

export interface KeyHint {
  readonly hint: string;
  /** Lower-cardinality attributes to group by instead. */
  readonly prefer: readonly string[];
}

const URL_HINT: KeyHint = {
  hint: 'Full URLs embed ids and query strings. Group by the route template instead.',
  prefer: ['http.route', 'url.template'],
};
const QUERY_HINT: KeyHint = {
  hint: 'Query text embeds literal values. Use parameterized queries and group by the query summary or operation and collection.',
  prefer: ['db.query.summary', 'db.operation.name', 'db.collection.name'],
};
const USER_HINT: KeyHint = {
  hint: 'Per-user values grow with your user base. Keep them on spans or logs if you need lookups; never use them as metric labels.',
  prefer: [],
};
const ADDRESS_HINT: KeyHint = {
  hint: 'Client addresses are per user or per connection. Drop them from metrics; hash or truncate them where kept.',
  prefer: [],
};
const PORT_HINT: KeyHint = {
  hint: 'Client ports are ephemeral, so nearly every connection gets a new value. Drop them from metrics.',
  prefer: [],
};
const MESSAGE_ID_HINT: KeyHint = {
  hint: 'Message and request ids are unique per event. Keep them on spans or logs only.',
  prefer: [],
};
const EXCEPTION_HINT: KeyHint = {
  hint: 'Exception text is free-form and often embeds ids. Group by the exception type.',
  prefer: ['exception.type', 'error.type'],
};
const USER_AGENT_HINT: KeyHint = {
  hint: 'Raw user-agent strings vary by browser build. Parse them into name and version, or drop them from metrics.',
  prefer: ['user_agent.name', 'user_agent.version'],
};
const DESTINATION_HINT: KeyHint = {
  hint: 'Temporary or per-entity destination names vary per message. Group by the destination template.',
  prefer: ['messaging.destination.template'],
};
const TRACE_ID_HINT: KeyHint = {
  hint: 'Trace and span ids are already part of every record; as attributes they add a unique value per request.',
  prefer: [],
};

const KEY_HINTS: ReadonlyMap<string, KeyHint> = new Map<string, KeyHint>([
  ['url.full', URL_HINT],
  ['url.original', URL_HINT],
  ['url.path', URL_HINT],
  ['url.query', URL_HINT],
  ['http.url', URL_HINT],
  ['http.target', URL_HINT],
  ['db.statement', QUERY_HINT],
  ['db.query.text', QUERY_HINT],
  ['user.id', USER_HINT],
  ['user.email', USER_HINT],
  ['user.name', USER_HINT],
  ['user.full_name', USER_HINT],
  ['enduser.id', USER_HINT],
  ['enduser.pseudo.id', USER_HINT],
  ['session.id', USER_HINT],
  ['client.address', ADDRESS_HINT],
  ['network.peer.address', ADDRESS_HINT],
  ['net.sock.peer.addr', ADDRESS_HINT],
  ['net.peer.ip', ADDRESS_HINT],
  ['http.client_ip', ADDRESS_HINT],
  ['client.port', PORT_HINT],
  ['network.peer.port', PORT_HINT],
  ['net.sock.peer.port', PORT_HINT],
  ['net.peer.port', PORT_HINT],
  ['messaging.message.id', MESSAGE_ID_HINT],
  ['messaging.message.conversation_id', MESSAGE_ID_HINT],
  ['request.id', MESSAGE_ID_HINT],
  ['http.request.id', MESSAGE_ID_HINT],
  ['gen_ai.response.id', MESSAGE_ID_HINT],
  ['exception.message', EXCEPTION_HINT],
  ['exception.stacktrace', EXCEPTION_HINT],
  ['user_agent.original', USER_AGENT_HINT],
  ['http.user_agent', USER_AGENT_HINT],
  ['messaging.destination.name', DESTINATION_HINT],
  ['trace_id', TRACE_ID_HINT],
  ['span_id', TRACE_ID_HINT],
  ['traceId', TRACE_ID_HINT],
  ['spanId', TRACE_ID_HINT],
]);

const CLASS_HINTS: ReadonlyMap<ValueClass, string> = new Map<ValueClass, string>([
  ['uuid', 'Values are unique identifiers. Keep them on spans or logs for lookups; never use them as metric labels or indexed fields.'],
  ['hexId', 'Values are unique identifiers. Keep them on spans or logs for lookups; never use them as metric labels or indexed fields.'],
  ['numericId', 'Values are numeric identifiers. Keep them on spans or logs for lookups; never use them as metric labels or indexed fields.'],
  ['token', 'Values look like tokens or keys: unique per value and possibly sensitive. Drop or hash them.'],
  ['email', 'Values are email addresses: personal data with per-user cardinality. Drop, hash or truncate them.'],
  ['ip', 'Values are IP addresses: per client and possibly personal data. Drop them from metrics; truncate or hash them where kept.'],
  ['timestamp', 'Values are timestamps, unique per event. Rely on the record timestamp instead.'],
  ['urlQuery', 'Values include query strings, which carry ids and tokens. Strip the query or use a route template.'],
  ['pathId', 'Values are paths containing ids. Use a route template (http.route or url.template).'],
  ['freeText', 'Values are free text, unique per event. Move the text to the log body or a span event and group by a low-cardinality type.'],
]);

/** Hint for a known high-cardinality key (exact, case-sensitive match). */
export function keyHint(key: string): KeyHint | undefined {
  return KEY_HINTS.get(key);
}

/** Hint for the dominant value class of a key, if that class suggests a fix. */
export function classHint(cls: ValueClass): string | undefined {
  return CLASS_HINTS.get(cls);
}
