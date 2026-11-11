// SPDX-License-Identifier: Apache-2.0

/** All contributed settings, merged across configuration sections (object or array form). */
export function configProperties(pkg: any): Record<string, any> {
  const cfg = pkg.contributes.configuration;
  const sections: any[] = Array.isArray(cfg) ? cfg : [cfg];
  return Object.assign({}, ...sections.map((s) => s.properties));
}
