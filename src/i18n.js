// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, button, errors). Errors
// thrown to Gladys are English (one language per message, like the core's);
// the statuses and button answers are { en, fr }. No text ever holds an
// address, the token or a position.
// -----------------------------------------------------------------------------

import { CODES } from './phonetrack/errors.js';

const plural = (n, one, many) => (n === 1 ? one : many);
/** French: 0 and 1 take the singular ("0 appareil muet"). */
const pluralFr = (n, one, many) => (n <= 1 ? one : many);
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/** A delay in words: minutes below 2 h, hours above. */
const delayText = (ms) => {
  const m = minutes(ms);
  if (m < 60) return { en: `${m} min`, fr: `${m} min` };
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const t = rest ? `${h} h ${rest} min` : `${h} h`;
  return { en: t, fr: t };
};

/** Why PhoneTrack failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.TLS_UNTRUSTED:
      return { en: 'certificate not trusted', fr: 'certificat non reconnu' };
    case CODES.TLS_CHANGED:
      return { en: 'certificate changed', fr: 'certificat changé' };
    case CODES.CLOSED:
      return { en: 'configuration changed', fr: 'configuration changée' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const RETRY = (delay) => {
  const d = delayText(delay);
  return { en: `Retried in ${d.en}.`, fr: `Nouvel essai dans ${d.fr}.` };
};

const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

export const T = {
  status: {
    ok: ({ total, silent, silentMinutes, capped }) =>
      join(
        {
          en: `PhoneTrack answers: ${total} ${plural(total, 'device', 'devices')}, ${silent} silent for more than ${silentMinutes} min.`,
          fr: `PhoneTrack répond : ${total} ${pluralFr(total, 'appareil', 'appareils')}, ${silent} ${pluralFr(silent, 'muet', 'muets')} depuis plus de ${silentMinutes} min.`,
        },
        capped > 0
          ? {
              en: `${capped} more ${plural(capped, 'device is', 'devices are')} left out (50 at most).`,
              fr: `${capped} ${pluralFr(capped, 'autre appareil est ignoré', 'autres appareils sont ignorés')} (50 au plus).`,
            }
          : {},
      ),
    noDevice: {
      en: 'PhoneTrack answers, but the session has no device with a position yet.',
      fr: 'PhoneTrack répond, mais la session n’a encore aucun appareil avec une position.',
    },
    urlMissing: {
      en: 'Type the address of your Nextcloud (e.g. https://cloud.example.org), or paste the API link of the session in the token field.',
      fr: 'Saisissez l’adresse de votre Nextcloud (ex. https://cloud.example.org), ou collez le lien API de la session dans le champ du jeton.',
    },
    urlInvalid: {
      en: 'The address of Nextcloud is not valid: type https://cloud.example.org (with its path if Nextcloud is in a folder), without a query.',
      fr: 'L’adresse de Nextcloud n’est pas valide : saisissez https://cloud.example.org (avec son chemin si Nextcloud est dans un dossier), sans paramètres.',
    },
    urlHttp: {
      en: 'The address uses http://: the share token, part of the address, would cross the network in clear. Use the https address of Nextcloud.',
      fr: 'L’adresse utilise http:// : le jeton de partage, qui fait partie de l’adresse, traverserait le réseau en clair. Utilisez l’adresse https de Nextcloud.',
    },
    urlCredentials: {
      en: 'Remove the user name and password from the address: Gladys uses only the public token of the session.',
      fr: 'Retirez l’identifiant et le mot de passe de l’adresse : Gladys n’utilise que le jeton public de la session.',
    },
    urlLink: {
      en: 'The address field holds a link with the token, shown in clear: keep only the address of Nextcloud here and paste the link in the token field.',
      fr: 'Le champ de l’adresse contient un lien avec le jeton, affiché en clair : gardez ici la seule adresse de Nextcloud et collez le lien dans le champ du jeton.',
    },
    urlMismatch: {
      en: 'The link pasted in the token field points to another server than the address typed: nothing was sent. Fix one of them.',
      fr: 'Le lien collé dans le champ du jeton pointe vers un autre serveur que l’adresse saisie : rien n’a été envoyé. Corrigez l’un des deux.',
    },
    missingToken: {
      en: 'Paste the public token of the session, or its API link (PhoneTrack, the session, Sharing, public sharing on).',
      fr: 'Collez le jeton public de la session, ou son lien API (PhoneTrack, la session, Partage, partage public activé).',
    },
    tokenInvalid: {
      en: 'The token is not a PhoneTrack token (letters and digits only) nor one of its links: paste it again.',
      fr: 'Le jeton n’est ni un jeton PhoneTrack (lettres et chiffres seulement) ni un de ses liens : collez-le de nouveau.',
    },
    fingerprintInvalid: {
      en: 'The certificate fingerprint must be a SHA-256 fingerprint: 64 hexadecimal digits, colons allowed.',
      fr: 'L’empreinte du certificat doit être une empreinte SHA-256 : 64 chiffres hexadécimaux, deux-points permis.',
    },
    tokenUnsupported: {
      en: 'This link is a public watch page or a filtered share: filtered share not supported. Paste the "API URL (JSON, last positions)" of the public session (or its token). Nothing was sent.',
      fr: 'Ce lien est une page de visualisation publique ou un partage filtré : partage filtré non pris en charge. Collez l’« API URL (JSON, last positions) » de la session publique (ou son jeton). Rien n’a été envoyé.',
    },
    configUnreadable: {
      en: 'Gladys did not give the configuration of the integration: read again in 1 min.',
      fr: 'Gladys n’a pas transmis la configuration de l’intégration : nouvelle lecture dans 1 min.',
    },
    refused: (status, delay) =>
      join({
        en: `Nextcloud refused the token (HTTP ${status}: session no longer public, share deleted, wrong token, an authentication in front of Nextcloud, or a firewall / proxy blocks Gladys). Each refusal counts as an attack for Nextcloud: Gladys stops for ${delayText(delay).en} (1 h, then 6 h, then 24 h). Saving the configuration tries once per series of refusals (another token or address: at once).`,
        fr: `Nextcloud a refusé le jeton (HTTP ${status} : session plus publique, partage supprimé, jeton faux, authentification devant Nextcloud, ou un pare-feu / proxy bloque Gladys). Chaque refus compte comme une attaque pour Nextcloud : Gladys s’arrête ${delayText(delay).fr} (1 h, puis 6 h, puis 24 h). Enregistrer la configuration fait un essai par série de refus (un autre jeton ou une autre adresse : tout de suite).`,
      }),
    stillRefused: (delay, forced = false) =>
      forced
        ? {
            en: `Nextcloud refused this token earlier, and it was already tried again: next attempt in ${delayText(delay).en} (another token or address is tried at once).`,
            fr: `Nextcloud a refusé ce jeton plus tôt, et il a déjà été réessayé : prochain essai dans ${delayText(delay).fr} (un autre jeton ou une autre adresse est essayé tout de suite).`,
          }
        : {
            en: `Nextcloud refused this token earlier: Gladys waits ${delayText(delay).en} before trying again (saving the configuration tries once at once).`,
            fr: `Nextcloud a refusé ce jeton plus tôt : Gladys attend ${delayText(delay).fr} avant de réessayer (enregistrer la configuration fait un essai tout de suite).`,
          },
    alreadyRetried: (delay) => ({
      en: `Already tried again after this refusal: next attempt in ${delayText(delay).en}. Saving the same token again does not shorten the stop (another token or address is tried at once).`,
      fr: `Déjà réessayé après ce refus : prochain essai dans ${delayText(delay).fr}. Enregistrer de nouveau le même jeton ne raccourcit pas l’arrêt (un autre jeton ou une autre adresse est essayé tout de suite).`,
    }),
    internal: (delay) =>
      join(
        {
          en: 'Internal error of the integration while reading the answer of PhoneTrack (see the logs of the integration).',
          fr: 'Erreur interne de l’intégration en lisant la réponse de PhoneTrack (voir les journaux de l’intégration).',
        },
        RETRY(delay),
      ),
    tooLarge: (delay) =>
      join(
        {
          en: 'Nextcloud answers, but the answer is too large (above 2 MB): too many devices in the session?',
          fr: 'Nextcloud répond, mais la réponse est trop grande (plus de 2 Mo) : trop d’appareils dans la session ?',
        },
        RETRY(delay),
      ),
    tlsUntrusted: (delay) =>
      join(
        {
          en: 'The certificate of Nextcloud is not trusted (self-signed?): install a certificate from a known authority, or type its SHA-256 fingerprint.',
          fr: 'Le certificat de Nextcloud n’est pas reconnu (auto-signé ?) : installez un certificat d’une autorité reconnue, ou saisissez son empreinte SHA-256.',
        },
        RETRY(delay),
      ),
    tlsChanged: (delay) =>
      join(
        {
          en: 'The certificate of Nextcloud is not the one of the typed fingerprint: nothing was sent. If you renewed it, type the new fingerprint; otherwise another machine may be impersonating the server.',
          fr: 'Le certificat de Nextcloud n’est pas celui de l’empreinte saisie : rien n’a été envoyé. Si vous l’avez renouvelé, saisissez la nouvelle empreinte ; sinon une autre machine se fait peut-être passer pour le serveur.',
        },
        RETRY(delay),
      ),
    notPhonetrack: (delay) =>
      join(
        {
          en: 'This address does not answer like PhoneTrack: check the address of Nextcloud and that the PhoneTrack app is installed and enabled.',
          fr: 'Cette adresse ne répond pas comme PhoneTrack : vérifiez l’adresse de Nextcloud et que l’application PhoneTrack est installée et activée.',
        },
        RETRY(delay),
      ),
    busy: (delay) =>
      join(
        {
          en: 'Nextcloud asks Gladys to slow down (HTTP 429, brute-force protection?): every request is paused.',
          fr: 'Nextcloud demande à Gladys de ralentir (HTTP 429, protection contre les attaques ?) : toutes les requêtes sont suspendues.',
        },
        RETRY(delay),
      ),
    serverError: (status, delay) =>
      join(
        {
          en: `Nextcloud answers with a server error (HTTP ${status}, maintenance?): every request is paused.`,
          fr: `Nextcloud répond par une erreur serveur (HTTP ${status}, maintenance ?) : toutes les requêtes sont suspendues.`,
        },
        RETRY(delay),
      ),
    paused: (delay) =>
      join(
        {
          en: 'Nextcloud asked Gladys to wait (HTTP 429 or a server error): the pause goes on.',
          fr: 'Nextcloud a demandé à Gladys d’attendre (HTTP 429 ou erreur serveur) : la pause continue.',
        },
        RETRY(delay),
      ),
    unreachable: (err, delay) =>
      join(
        { en: 'Nextcloud does not answer:', fr: 'Nextcloud ne répond pas :' },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
  },
  test: {
    ok: ({ total, silent }) => ({
      en: `Connected: ${total} ${plural(total, 'device', 'devices')}, ${silent} silent. Add them from the Discovery tab.`,
      fr: `Connecté : ${total} ${pluralFr(total, 'appareil', 'appareils')}, ${silent} ${pluralFr(silent, 'muet', 'muets')}. Ajoutez-les depuis l’onglet Découverte.`,
    }),
  },
  errors: {
    readOnly: 'This integration only reads PhoneTrack: nothing can be changed from Gladys',
    notConnected: 'PhoneTrack is not connected: see the configuration of the integration',
    testTooLong:
      'Nextcloud has not answered yet: see the connection status in a moment (nothing else to do)',
  },
};
