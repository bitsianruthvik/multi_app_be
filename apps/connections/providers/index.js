import onedrive from './onedrive.js';

/**
 * The kinds of connection. To add one, write a file next to onedrive.js and list it here.
 *
 * A provider is read-only and exports:
 *   key, label, description
 *   setupHelp                      a line for the Add form
 *   fields                         [{ key, label, required, secret, placeholder, help }]; the form is built from these
 *   validate(config)               throws { status: 400 } on a bad value, returns the config to store
 *   test({ config, secrets })      → { resolved, summary }; resolved is stored and passed back as `resolved`
 *   listFiles({ config, secrets, resolved }, folderId?)  → [{ id, name, kind, size, modifiedAt, etag, webUrl }]
 *   openFile({ config, secrets, resolved }, fileId)      → { name, size, stream }
 */
const PROVIDERS = [onedrive];

export const getProvider = (key) => PROVIDERS.find((p) => p.key === key) ?? null;

/** What the screen needs: no methods. */
export const describeProviders = () => PROVIDERS.map(({ key, label, description, setupHelp, fields }) => (
  { key, label, description, setupHelp, fields }
));
