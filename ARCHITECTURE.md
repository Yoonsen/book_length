## Arkitektur: Korpus-først, frekvensprofilert app

Denne appen følger en korpus-først modell: vi "typeløfter" et konkret korpus inn i en håndterbar mengde funksjoner, og velger bare det som gir mening for akkurat dette korpuset. Her er primærfunksjonen frekvenstelling, ikke konkordans.

I praksis betyr det:

- små korpus kan ha mer interaktiv dokumentseleksjon
- store korpus bør ha enklere filtrering og tydelige grenser
- API-kontrakt og datamodell holdes stabile, mens UI-funksjoner skaleres etter korpustype

### 1) Domene

- **Korpusmetadata**: lokal CSV med minst `urn` og `title` (og gjerne `year`, `author`, `gender`).
- **Ordfrekvens**: NB DH-lab via `POST https://api.nb.no/dhlab/frequencies`.
- **Visning**:
  - frekvensrader per ord og dokument
  - summering/aggregat ved behov
  - eksport av tabell til Excel (`.xlsx`) ved behov

### 2) Endepunkt og payload

#### Frekvens-endepunkt

- URL: `https://api.nb.no/dhlab/frequencies`
- Metode: `POST`
- Header: `Content-Type: application/json`

Eksempelpayload:

```json
{
  "cutoff": 1,
  "urns": ["URN:NBN:no-nb_digibok_2011051112001"],
  "words": ["og", "i", "som"]
}
```

Eksempelrespons:

```json
[
  [100619991, "og", 547, 34506],
  [100619991, "i", 341, 34506],
  [100619991, "som", 162, 34506]
]
```

Radformat:

- `0`: `dhlabid`
- `1`: `word`
- `2`: `count`
- `3`: `total`

Notater:

- `urns` brukes som input i startfasen
- API returnerer `dhlabid`, som kan brukes til stabil join i appen
- samme `dhlabid` forventes for alle ord i samme dokument

### 3) Join-strategi mot korpus

Utfordring: CSV-en kan mangle eksplisitt `dhlabid`-kolonne (for eksempel har den bare `new_urns`).

Strategi:

1. Les korpusfilen lokalt.
2. Normaliser URN-felt (`urn` eller fallback `new_urns`).
3. Kall `POST https://api.nb.no/dhlab/get_metadata` for korpusets URN-er.
4. Bygg mapping `urn -> dhlabid` fra metadataresponsen.
5. Berik lokal korpusstruktur med `dhlabid`.
6. Send frekvenskall med `urns` + valgte `words`.
7. Join visningsdata mot lokal metadata via:
   - primært: `dhlabid`
   - fallback: `urn` (hvis noen rader mangler mapping)

Dette gir en robust flyt der vi etablerer en stabil `dhlabid`-nøkkel før frekvenshenting.

### 4) Hovedmoduler

- **`src/App.tsx`**
  - leser manifest og korpusfil
  - normaliserer CSV-felter (`urn`/`new_urns`)
  - kaller `POST /dhlab/frequencies`
  - normaliserer respons til interne rader med metadata
- **`src/App.css`**
  - stil for enkel tabellvisning og filtre
- **`app.manifest.json`**
  - konfigurerer appnavn, korpusfil og API-url

### 5) Dataflyt

1. CSV leses lokalt i nettleser.
2. Bruker velger ordliste (og ev. dokumentsubsett).
3. `urns` + `words` + `cutoff` sendes til `POST /dhlab/frequencies`.
4. API-svar normaliseres til en intern frekvensliste.
5. `dhlabid` og `urn` brukes til join mot lokal metadata.
6. Resultat sorteres og vises i tabell.
7. Eksport bruker samme normaliserte tabell.

### 6) UI-prinsipper

- **Skarp kjerne**: kun frekvenstelling.
- **Ingen konkordansvisning**: ingen HTML-markerte treff.
- **Korpus-tilpasset kontroll**:
  - små korpus: manuell dokumentseleksjon
  - store korpus: enklere filtermodell

### 7) Utskiftbare deler

- Bytt normalt:
  - `corpus.metadataFile` i manifest
  - `api.frequenciesUrl` i manifest
  - appnavn/tittel
  - grad av dokumentfilter
- Behold normalt:
  - `/dhlab/frequencies`-kontrakt
  - normalisering av responsradene
  - join mot lokal korpusmetadata
  - deploy-flyt til GitHub Pages

### 8) Driftsmodell

- Lokal utvikling: `npm run dev`
- Produksjonsbygg: `npm run build`
- Deploy: GitHub Actions -> GitHub Pages
