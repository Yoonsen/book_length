## Malguide: korpusoppskrift for frekvenstelling

Bruk denne guiden når du lager en ny korpusapp etter samme modell: korpus-først, med en tydelig funksjonsprofil (her: frekvenstelling).

### 1) Tenkemåte før kode

- Ikke bygg "one size fits all".
- Velg funksjoner ut fra korpusstørrelse og bruksmønster:
  - **små korpus**: manuell dokumentseleksjon, fliser, mer interaktiv UI
  - **store korpus**: enklere filtrering, mindre visuell overhead, tydelige grenser
- Hold API-kontrakt og dataflyt stabil på tvers av instanser.

### 2) Hurtigoppskrift

1. Legg korpus-CSV i rot.
2. Oppdater `app.manifest.json`:
   - `corpus.metadataFile`
   - `api.frequenciesUrl`
   - `api.metadataUrl`
   - `appName`
3. Verifiser CSV-felter (`urn` eller `new_urns`, samt `title` minst).
4. Kjør lokalt:
   - `npm install`
   - `npm run dev`
5. Push og deploy via GitHub Actions.

### 3) Endepunkt og payload (frekvens)

- Endepunkt: `POST https://api.nb.no/dhlab/frequencies`
- Header: `Content-Type: application/json`

Eksempelpayload:

```json
{
  "cutoff": 1,
  "urns": ["URN:NBN:no-nb_digibok_2011051112001"],
  "words": ["og", "i", "som"]
}
```

Viktig:

- input sendes med `urns` + `words`
- respons kommer som radliste på format `[dhlabid, word, count, total]`
- normaliser respons for UI (for eksempel objekt med feltene `dhlabid`, `word`, `count`, `total`)

### 4) Minimumskrav til CSV

CSV bør minst ha:

- `urn` (eller `new_urns`)
- `title`

Valgfritt:

- `year` og andre metadatafelt

### 5) UI-oppskrift (anbefalt baseline)

- Ordinput (ett eller flere ord) + submit
- Frekvenstabell sortert på valgte kolonner
- Dokumentseleksjon (velg/uvelg) når korpuset er lite nok
- Ingen konkordansvisning
- Nedlasting av frekvenstabell som Excel (`.xlsx`) ved behov

### 6) Metadataoppslag (`urn -> dhlabid`)

- Endepunkt: `POST https://api.nb.no/dhlab/get_metadata`
- Brukes før frekvenskall for å berike korpusdata med `dhlabid`
- Input bør være korpusets URN-liste
- Resultatet brukes til stabil join i appen

### 7) Hva man vanligvis tuner

- labeltekster og hjelpetekst
- default parametre (`cutoff`, ordliste, antall dokumenter)
- graden av dokumentvalg i UI
- eksportkolonner

### 8) Hva som normalt ikke røres

- grunnkontrakt mot `/dhlab/frequencies`
- metadataoppslag via `/dhlab/get_metadata`
- join mellom API-rader og lokal metadata via `dhlabid` (fallback `urn`)
- deploy-workflow til GitHub Pages
