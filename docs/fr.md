# PhoneTrack

Les téléphones (et autres traceurs) d'une session
[PhoneTrack](https://github.com/julien-nc/phonetrack) dans Gladys. PhoneTrack
est l'application de localisation de Nextcloud : vos téléphones envoient
leur position à votre propre Nextcloud (avec l'application Android
PhoneTrack, OwnTracks, GpsLogger, Traccar Client, uLogger…), et Gladys lit
la dernière par le lien public en lecture seule de la session.

- chaque appareil PhoneTrack devient un appareil Gladys : **latitude**,
  **longitude**, **batterie** (%), **précision** (m), **vitesse** (km/h),
  **altitude** (m), **cap** (°), **satellites** (si l'application les
  envoie), **vu pour la dernière fois** et **muet** ;
- un déclencheur de scène **Appareil muet** : aucune nouvelle position
  depuis 15 minutes à 24 heures (au choix dans la scène).

Lecture seule, en interrogation : Gladys lit Nextcloud à intervalle
régulier. Rien à ouvrir sur votre réseau, pas de webhook : cela marche
derrière un NAT, du moment que Gladys joint votre Nextcloud.

> **Cette intégration n'a jamais été testée avec un vrai Nextcloud.** Cette
> première version a été écrite d'après les routes et la documentation de
> PhoneTrack, et testée contre un faux PhoneTrack seulement. Dites sur le
> forum Gladys ce qui marche et ce qui ne marche pas.

Intégration non officielle, sans lien avec PhoneTrack ni Nextcloud.

## À qui sert-elle ?

- **Sans Gladys Plus** : Gladys n'a pas de moyen tout prêt de recevoir la
  position d'un téléphone (OwnTracks passe par la passerelle Gladys Plus).
  Avec votre propre Nextcloud, cette intégration amène vos téléphones dans
  Gladys sans Gladys Plus : où ils sont, leur batterie, et s'ils donnent
  encore signe de vie.
- **Avec Gladys Plus** : OwnTracks déplace déjà votre utilisateur sur la
  carte de Gladys. PhoneTrack ajoute ce qu'OwnTracks n'apporte pas à
  Gladys : la **batterie** de chaque téléphone, le **silence** d'un
  téléphone (une scène quand il n'envoie plus rien) et, côté Nextcloud,
  l'**historique** complet des trajets et les **alertes de proximité** entre
  deux appareils (pas encore dans Gladys : voir « Limites »).

## Avant de commencer : un lien en lecture seule

1. Dans Nextcloud, ouvrez **PhoneTrack**, choisissez la session de vos
   téléphones et ouvrez ses réglages de **partage**.
2. Activez **Public session** (session publique). PhoneTrack affiche alors
   un **Public watch link** (lien de visualisation publique) et une **API
   URL (JSON, last positions)** (URL de l'API, dernières positions).
3. Copiez l'**API URL (JSON, last positions)** : elle finit par
   `/apps/phonetrack/api/getlastpositions/<jeton>`. Collez-la telle quelle
   dans le champ **Jeton public ou lien API** de Gladys (ou seulement le
   jeton, la dernière partie, avec l'adresse de votre Nextcloud dans l'autre
   champ).

Attention à ce que donne ce lien : toute personne qui l'a voit **toutes les
positions de la session**, en lecture seule, sans mot de passe. Gardez-le
comme un mot de passe. Gladys le garde dans sa base, ne le réaffiche
jamais, ne l'écrit dans aucun journal et ne l'envoie qu'à votre Nextcloud.
Désactiver **Public session** dans PhoneTrack coupe l'accès aussitôt
(Gladys voit alors un refus).

Les **Share link** du même panneau (partages publics filtrés) ne sont pas
pris en charge par cette version : utilisez l'URL de l'API de la session
publique. Un lien de page de visualisation (lien public, partage filtré)
collé dans Gladys est refusé avec un message clair, avant toute requête.

## Configuration

- **Adresse de Nextcloud** : `https://cloud.example.org`, avec son dossier
  si Nextcloud est dans un dossier (`https://example.org/nextcloud`). Peut
  rester vide si l'URL complète de l'API est collée dans le champ suivant.
  `http://` est refusé : le jeton fait partie de l'adresse de la requête et
  traverserait le réseau en clair. Un lien avec le jeton saisi ici (un
  champ affiché en clair) est refusé aussi.
- **Jeton public ou lien API** : voir ci-dessus. Si les deux champs sont
  remplis, le lien doit pointer vers le même Nextcloud, sinon rien n'est
  envoyé.
- **Empreinte du certificat** (facultatif) : par défaut le certificat de
  Nextcloud doit venir d'une autorité reconnue (Let's Encrypt…). Un
  Nextcloud avec son propre certificat : saisissez son empreinte SHA-256 ;
  ce certificat, et aucun autre, est alors accepté, vérifié avant l'envoi du
  jeton. Après un renouvellement, saisissez la nouvelle. Pour la lire :
  votre navigateur (cadenas, certificat, empreinte SHA-256) ou
  `openssl s_client -connect cloud.example.org:443 </dev/null | openssl x509 -noout -fingerprint -sha256`.
- **Rafraîchissement** : de toutes les 30 secondes à toutes les 10 minutes
  (toutes les minutes par défaut). Une requête par lecture. PhoneTrack ne
  sait que ce que les téléphones ont envoyé : leur propre intervalle d'envoi
  compte autant.
- **Muet après** : de 15 minutes à 24 heures (1 heure par défaut) : le
  délai sans nouvelle position au bout duquel la fonction **Muet** s'allume.

Ouvrez ensuite l'onglet **Découverte** et créez les appareils à suivre.
Seuls les appareils créés reçoivent leurs valeurs.

## Ce que montre chaque fonction

- **Latitude / Longitude** : la dernière position, en degrés, arrondie à 6
  décimales (une dizaine de centimètres). Les deux partent toujours
  ensemble. Pas d'historique par défaut (vie privée ; vous pouvez l'activer
  dans l'appareil).
- **Batterie** (%) : la batterie du téléphone à ce point, si l'application
  l'envoie.
- **Précision** (m), **Altitude** (m), **Cap** (°, 0 = nord) : tels que
  l'application les a envoyés.
- **Vitesse** (km/h) : PhoneTrack stocke des mètres par seconde (ce que
  supposent ses propres pages) ; Gladys convertit. Pas encore vérifié avec
  chaque application.
- **Satellites** : seulement pour les appareils dont l'application l'envoie
  (la fonction apparaît dans la Découverte une fois vue ; mettez à jour
  l'appareil créé pour l'ajouter).
- **Vu pour la dernière fois** : l'heure de la dernière position, sous la
  forme `2026-10-18 08:00 UTC` (UTC : l'intégration ne connaît pas le
  fuseau de Gladys).
- **Muet** (1 / 0) : aucune nouvelle position depuis le délai de la
  configuration. Calculé d'après l'heure du dernier point (l'horloge du
  téléphone) et l'horloge de Gladys.
- Une valeur que l'application n'a pas envoyée n'est pas publiée. Gladys
  accepte 300 états par minute d'une intégration : celle-ci en envoie 250
  au plus, muet d'abord, puis les positions, la batterie, les autres nombres
  et le texte « vu pour la dernière fois ». Avec beaucoup d'appareils créés
  d'un coup, les premières valeurs arrivent en quelques minutes.

## Déclencheur de scène : Appareil muet

Choisissez l'appareil (ou tous) et le délai (**obligatoire** : de 15
minutes à 24 heures). La scène démarre quand l'appareil n'a envoyé aucune
nouvelle position depuis ce délai, à la lecture suivante. Seuls les
appareils créés dans Gladys (onglet Découverte) déclenchent. **Une fois par
silence** : de nouveau seulement après une nouvelle position (de moins de
15 minutes) ; un lot tardif de vieux points ne relance rien. Jamais pour un
délai déjà atteint au démarrage de l'intégration (aucun événement à la
première lecture), ni pour un appareil vu pour la première fois, ni à une
lecture où l'horloge de Gladys a sauté (remise à l'heure après un
démarrage). 30 événements au plus par lecture : les autres partent à la
suivante. Variables : nom de l'appareil, muet depuis (minutes), vu pour la
dernière fois.

## Problèmes de connexion

- **Jeton refusé** (HTTP 401 ou 403, ou le 404 « Session not found » de
  PhoneTrack : la session n'est plus publique, le jeton est faux, une
  authentification est placée devant Nextcloud, ou un pare-feu / proxy
  bloque Gladys) : Nextcloud compte chaque refus comme une attaque et peut
  ralentir ou bloquer l'adresse de Gladys. Gladys s'arrête donc **1
  heure**, puis **6 heures**, puis **24 heures** après chaque nouveau refus,
  jamais en boucle. L'arrêt est gardé dans `/data`, même quand la réponse
  arrive pendant que Gladys est absent : un redémarrage ou une reconnexion
  de Gladys attend aussi, de même que le bouton de test. Un essai encore en
  cours quand l'intégration s'arrête compte comme un refus. Pendant une
  série de refus, toute autre panne (un délai dépassé) attend aussi la fin
  de l'arrêt en cours. Enregistrer la configuration avec le même jeton fait
  **un** essai tout de suite par série de refus ; ensuite le statut indique
  qu'il a déjà été réessayé et quand aura lieu le prochain essai. Un autre
  jeton ou une autre adresse est essayé tout de suite. Une lecture réussie
  oublie les refus.
- **Nextcloud surchargé** (HTTP 429, sa protection contre les attaques) ou
  **erreur serveur** (HTTP 5xx, maintenance) : toutes les requêtes sont
  suspendues, le temps que Nextcloud demande (Retry-After) entre 1 minute et
  6 heures, jamais moins que le rafraîchissement. La pause est gardée dans
  `/data`.
- **Pas PhoneTrack** (une page 404 qui n'est pas la réponse de PhoneTrack,
  une réponse inattendue) : vérifiez l'adresse et que l'application
  PhoneTrack est activée. Nouvel essai après le rafraîchissement (une minute
  au moins), puis le délai double jusqu'à 30 minutes.
- **Réponse trop grande** (plus de 2 Mo) ou **erreur interne** de
  l'intégration : dit comme tel (jamais « Nextcloud ne répond pas »), mêmes
  essais. Un appareil avec une valeur impossible (une date hors limites)
  est ignoré seul : les autres continuent.
- **Nextcloud injoignable** (réseau, délai de 45 s dépassé, certificat) :
  mêmes essais ; les appareils apparaissent injoignables entre-temps.
  L'intégration n'abandonne jamais.
- **Configuration non transmise par Gladys** à une reconnexion : la
  dernière reçue sert, sinon le statut le dit et elle est relue toutes les
  minutes.
- **Tester la connexion** relit et dit combien d'appareils répondent ; il
  ne raccourcit jamais un arrêt ni une pause.

## Vie privée

Aucune position, aucun nom d'appareil, aucun jeton ni aucune adresse n'est
jamais écrit dans un journal ni dans le volume `/data` de l'intégration
(elle n'y garde qu'une empreinte salée du jeton après un refus, et la fin
d'une pause). Les positions ne vont qu'à Gladys. Les identifiants externes
des appareils sont des empreintes du jeton et du nom de l'appareil, jamais
le jeton lui-même. L'agent utilisateur de l'application n'entre jamais dans
Gladys.

## Limites

- **Gladys ne déplace pas encore un utilisateur Gladys sur sa carte d'après
  PhoneTrack** : une intégration ne peut pas publier la position d'un
  utilisateur aujourd'hui (seul OwnTracks, par Gladys Plus, le peut). Une
  petite modification de Gladys est nécessaire ; elle est notée dans le
  dépôt (TODO.md) et viendra dans une version suivante si Gladys l'accepte.
  D'ici là, les zones de Gladys ne réagissent pas à PhoneTrack.
- Une session PhoneTrack par intégration, 50 appareils au plus (les
  appareils créés dans Gladys d'abord, puis les autres par nom).
- Renommer un appareil dans PhoneTrack crée un nouvel appareil Gladys
  (l'ancien reste sans valeurs).
- Prévu plus tard : les zones (geofences) de PhoneTrack en push, la
  présence par zone, la proximité entre deux appareils, l'historique et
  l'export GPX, un widget « trajet du jour », plusieurs sessions, un mode
  « zone seulement » qui n'envoie jamais la position exacte.
- Jamais testée avec un vrai Nextcloud : voir TODO.md dans le dépôt.
