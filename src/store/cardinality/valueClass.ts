// SPDX-License-Identifier: Apache-2.0
// Value classes of attribute values. Types and constants only, with no Node or vscode import, so webviews
// can share them.

export type ValueClass =
  | 'uuid'
  | 'hexId'
  | 'numericId'
  | 'token'
  | 'email'
  | 'ip'
  | 'timestamp'
  | 'urlQuery'
  | 'pathId'
  | 'freeText'
  | 'number'
  | 'other';

export const VALUE_CLASSES: readonly ValueClass[] = [
  'uuid',
  'hexId',
  'numericId',
  'token',
  'email',
  'ip',
  'timestamp',
  'urlQuery',
  'pathId',
  'freeText',
  'number',
  'other',
];

/** Classes whose values are unique per entity or event. */
export const ID_CLASSES: ReadonlySet<ValueClass> = new Set<ValueClass>([
  'uuid',
  'hexId',
  'numericId',
  'token',
  'email',
  'ip',
  'timestamp',
  'urlQuery',
  'pathId',
]);

/** Share of classified values a class needs to describe the key. */
export const DOMINANT_SHARE = 0.8;
