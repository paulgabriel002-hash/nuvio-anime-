# AnimeNexus pentru Nuvio

Provider (plugin) pentru **Nuvio** care aduce sursele de pe [anime-nexus.io](https://anime-nexus.io/) — site-ul românesc de anime, fostul AnimeKage.

În lista de surse a unui episod/film apare providerul **AnimeNexus**, cu mai multe servere rezolvate direct (HLS/MP4), gata de redat în playerul Nuvio.

---

## Ce face

1. Ia ID-ul TMDB al titlului din Nuvio.
2. Îl rezolvă la titlu + sezon + an (TMDB).
3. Caută titlul în catalogul AnimeNexus (`/nexus/series/search`).
4. Alege intrarea corectă (inclusiv sezoane separate, ex. „Attack on Titan 2”).
5. Deschide pagina episodului și extrage serverele listate de site.
6. Rezolvă serverele pentru care există extractor și returnează stream-urile.

Nu descarcă și nu găzduiește conținut. Doar citește paginile publice ale site-ului, cu sesiunea contului tău.

---

## Serverele suportate

| Server din AnimeNexus | Stare |
|---|---|
| **Voe** | ✅ HLS direct (de obicei 720p/1080p). |
| **EarnVid / VidHide (Morencius)** | ✅ HLS direct (720p). |
| **VTube (vtbe.to)** | ✅ HLS direct (1080p). |
| **VidMoly** | ✅ HLS direct (720p/1080p). |
| **MP4upload** | ✅ MP4 direct. |
| **DoodStream (vide0.net / playmogo)** | ⚠️ Rezolvat, dar unele rețele primesc `403` de la Dood. |
| **LuluStream (luluvido)** | ⚠️ Rezolvat, dar CDN-ul dă `403` pe unele IP-uri; sursa e eliminată automat când masterul nu răspunde. |
| FileMoon / Byse | ❌ Player iframe fără API public stabil. |
| Vidara | ❌ API intern respinge cererile fără context de browser. |
| HydraX / Abyss | ❌ Player iframe cu token generat în browser. |
| StreamTape | ❌ `get_video` răspunde cu eroare pentru integrări automate. |
| UQLOAD / StreamHG / Mega / AbStream / HexUpload / SaveFiles | ❌ Neimplementate. |

Practic, pentru majoritatea episoadelor vei vedea **2–5 surse** (Voe + VidHide + VTube + VidMoly + MP4upload, uneori Dood/Lulu). Site-ul listează mai multe, dar o parte sunt playere iframe fără URL direct.

---

## Cerințe

- **Cont AnimeNexus** (site-ul cere autentificare pentru catalog și pagini).
- **Nuvio** într-o versiune care suportă pluginuri (build-ul complet Android/iOS; build-ul din Play Store poate avea pluginurile dezactivate).
- Acces la un browser pentru copierea cookie-ului de sesiune.

---

## Contul separat

A fost creat un cont separat (nu contul tău principal), cu invitația primită. Datele de acces sunt în mesajul de livrare — **nu le pune într-un repository public**.

Sunt două variante:

### A. Cookie de „remember me” (recomandat)

Cel mai stabil. În loc de `PHPSESSID`, folosește cookie-urile long-lived:

```
usri=...; usrs=...
```

Acestea țin sesiunea aproximativ un an și nu necesită login la fiecare episod. Le lipești o dată în setarea **Cookie sesiune**.

### B. Utilizator + parolă

Pluginul se loghează automat la fiecare rulare. Merge, dar site-ul limitează login-urile repetate (`Încearcă peste un minut`). Dacă apare mesajul, așteaptă un minut sau treci pe cookie.

---

## Instalare

### Varianta A — GitHub (recomandat, permanent)

1. Creează un repository **public** pe GitHub.
2. Încarcă în rădăcina repository-ului:
   - `manifest.json`
   - folderul `providers/` cu `anime-nexus.js`
3. În Nuvio: **Settings → Plugins → Add repository** și lipește:

   ```
   https://raw.githubusercontent.com/UTILIZATOR/REPO/main
   ```

   (Nuvio adaugă automat `/manifest.json`.)
4. Activează **AnimeNexus** din lista de pluginuri.
5. Deschide **setările pluginului** și pune cookie-ul (sau user + parolă).

Dacă folosești alt branch, schimbă `main` cu numele branch-ului.

### Varianta B — server local (test rapid)

```bash
node server.js
```

Apoi în Nuvio adaugă:

```
http://IP-UL-PC-ului:8787
```

Telefonul/televizorul trebuie să fie în aceeași rețea. Unele build-uri Android blochează traficul HTTP simplu; în acest caz folosește varianta A.

---

## Cookie-ul de sesiune

### Cookie long-lived (recomandat)

După login, în DevTools → **Application → Storage → Cookies → https://anime-nexus.io**, copiază valorile pentru:

- `usri`
- `usrs`

(opțional `dv` și `cdd`, dacă vrei să fie identic cu browserul)

Formează:

```
usri=...; usrs=...
```

### Cookie de sesiune (alternativ)

Dacă folosești `PHPSESSID`, copiază tot headerul `Cookie` din **Network → Request Headers**. Sesiunea expiră mai repede.

**Securitate:** cookie-ul îți permite accesul la cont. Nu îl trimite nimănui. Te poți deloga din site ca să-l invalidezi.

---

## Setări

| Setare | Ce face |
|---|---|
| **Cookie sesiune** | `usri=...; usrs=...` (recomandat) sau `PHPSESSID=...`. |
| **Utilizator / parolă** | Opțional. Autentificare automată pentru conturi **fără 2FA**. |
| **Număr maxim de surse** | Implicit 40. |
| **Base URL** | Doar pentru debug. Implicit `https://anime-nexus.io`. |
| **User-Agent** | Opțional. Folosește același browser din care ai copiat cookie-ul dacă Cloudflare face probleme. |
| **TMDB API key** | Opțional. Implicit se folosește cheia pusă la dispoziție de Nuvio. |
| **Loguri detaliate** | Loguri suplimentare în consolă. |

---

## Cum arată în Nuvio

La un episod, în lista de stream-uri:

```
AnimeNexus   1080p • Voe • Subtitrat RO
AnimeNexus   720p • EarnVid (VidHide) • Subtitrat RO
AnimeNexus   480p • MP4upload • Subtitrat RO
```

Playerul Nuvio redă HLS-ul/MP4-ul direct. Subtitrările sunt cele incluse de sursă (de regulă arse în video).

---

## Depanare

| Problemă | Cauză / soluție |
|---|---|
| Nu apare nicio sursă | Cookie lipsă/expirat, cont inexistent sau site-ul cere din nou login. Copiază cookie-ul proaspăt. |
| „Încearcă peste un minut” | Rate limit la login. Așteaptă 1 minut sau folosește cookie-ul long-lived. |
| Doar o sursă | Unele episoade au doar Voe; restul host-urilor pot lipsi sau pot fi blocate. |
| DoodStream lipsește | Dood poate răspunde cu `403` pentru unele rețele. |
| LuluStream lipsește | CDN-ul răspunde cu `403`; sursa este eliminată automat. |
| Merge pe telefon, nu pe TV | Unele build-uri TV au pluginurile dezactivate; verifică versiunea Nuvio. |
| Anime greșit / sezon greșit | Maparea TMDB → catalogul AnimeNexus poate rata titluri obscure sau sezoane divizate. |
| Cloudflare / pagină de verificare | Cookie-ul trebuie să includă și `cf_clearance`; copiază tot headerul `Cookie` din browser. |

Logurile pluginului apar în consola Nuvio (Android: `adb logcat | grep AnimeNexus`).

---

## Structură

```
anime-nexus-nuvio/
├── manifest.json
├── providers/
│   └── anime-nexus.js
├── test/
│   └── run.js
├── server.js
├── package.json
└── README.md
```

---

## Test local

```bash
node test/run.js
```

Pentru site-ul real ai nevoie de cookie:

```powershell
$env:AN_COOKIE="usri=...; usrs=..."
node test/run.js
```

Poți filtra cazurile:

```powershell
$env:AN_ONLY="Ao Ashi"
node test/run.js
```

---

## Disclaimer

- Proiect neoficial, neafiliat cu AnimeNexus sau Nuvio.
- Nu găzduiește și nu distribuie conținut. Toate stream-urile provin de la serverele terțe folosite de AnimeNexus.
- Folosește pluginul doar în limitele legii din țara ta și ale contului tău.
- Site-ul își poate schimba structura oricând; pluginul poate necesita actualizări.
