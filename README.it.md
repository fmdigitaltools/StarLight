# StarLight

[English](README.md) · **Italiano**

<!-- image: StarLight logo -->

StarLight è un programma libero e gratuito per Windows dedicato all'elaborazione delle immagini astronomiche.
Accompagna il lavoro dai file di ripresa all'immagine finita, lungo un percorso a passi in cui ogni scelta automatica
resta regolabile e spiegata.

È pensato in primo luogo per le riprese impilate, cioè per sommare molti scatti dello stesso oggetto e far emergere il
segnale dal rumore; è in grado di assistere anche nel miglioramento di una singola immagine già impilata, per esempio
quella prodotta da un telescopio.

<!-- image: the main window with a processed image -->

## Funzioni

Il lavoro segue otto passi, nell'ordine in cui compaiono nel programma.

1. **Importa**: carica singoli file o un'intera cartella. StarLight riconosce da solo gli scatti del cielo, i frame di
   calibrazione e i file già impilati leggendo solo l'intestazione, così anche centinaia di file si caricano in pochi
   istanti.
2. **Calibra**: costruisce i master (dark, flat, bias) e li applica agli scatti, separando in automatico i frame ripresi
   in condizioni diverse (esposizione, guadagno, temperatura, filtro, notte).
3. **Impila**: allinea le stelle di ogni frame, scarta quelli mossi e somma gli altri, togliendo le scie dei satelliti e
   i raggi cosmici.
4. **Elabora**: correzione dei difetti e del fondo cielo, scie dei satelliti, calibrazione del colore, deconvoluzione,
   riduzione del rumore, dettagli per scala, banda stretta, riduzione delle stelle, contrasto locale e plugin.
5. **Correggi**: stiramento dell'istogramma, curve, toni e colore, regolazioni locali con le maschere.
6. **Filtri**: filtri fotografici per la resa del colore, dal seppia ai falsi colori, oltre a riduzione del rumore,
   nitidezza e vignettatura.
7. **Oggetti**: riconoscimento degli oggetti del cielo profondo nel campo inquadrato, segnati sull'immagine con un
   cerchio e il loro nome.
8. **Esporta**: salvataggio dell'immagine nel formato e nelle dimensioni desiderati.

Accanto ai passi sono disponibili:

- **Abracadabra**: un pulsante che misura l'immagine, regola gli strumenti di Elabora e Correggi e riassume le
  correzioni fatte. Ogni valore resta modificabile e Ripristina riporta l'immagine all'originale.
- **Riconoscimento degli oggetti e risoluzione astrometrica**: se il file non contiene già la soluzione astrometrica (la
  corrispondenza fra ogni pixel e un punto del cielo), StarLight la calcola confrontando le stelle della foto con un
  catalogo, anche senza internet quando è installato il pacchetto delle stelle.
- **Sessione dal vivo**: sorveglianza della cartella in cui il programma di ripresa salva i frame, con l'impilamento
  aggiornato durante la ripresa.
- **Mosaico**: unione di più campi vicini in un campo più ampio, con fondo e luminosità accordati e bordi sfumati.
- **Drizzle**: somma dei frame su una griglia con il doppio dei pixel per lato, sfruttando i piccoli spostamenti fra
  uno scatto e l'altro.
- **Fusione HDR**: unione di serie riprese con esposizioni diverse, per conservare sia le parti deboli sia quelle
  luminose.
- **Comete**: impilamento con le stelle ferme, la cometa ferma o entrambe.
- **Plugin e cataloghi aggiuntivi**: una galleria di strumenti aggiuntivi liberi e gratuiti, ampliabile con plugin
  personali, e cataloghi di oggetti da scaricare oltre a quello incluso.
- **Didascalia all'esportazione**: una riga o una scheda con l'oggetto, i dati della ripresa e il nome dell'autore,
  disegnata sull'immagine esportata.
- **Elaborazione in serie**: la stessa ricetta applicata a più immagini, con un file per ciascuna.
- **Aggiornamenti automatici**: un avviso quando esce una versione nuova e, su richiesta, l'installazione.

## Formati

**In ingresso**

- FITS, compresi quelli compressi a tasselli (file `.fz`)
- XISF
- TIFF
- PNG
- RAW delle fotocamere (CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, DNG e altri)

I file JPEG non sono accettati, perché la compressione con perdita cancella proprio i dettagli deboli che l'elaborazione
astronomica deve far emergere.

**In uscita**

- FITS a 16 o 32 bit, con i dati dello scatto e la soluzione astrometrica
- TIFF a 8 o 16 bit per canale
- PNG, BMP
- JPEG, WebP (con perdita, per la condivisione)

I segni degli oggetti si possono disegnare anche nei file PNG, JPEG e WebP.

## Installazione

1. Aprire la pagina [Releases](../../releases) del progetto.
2. Scaricare il file `StarLight-Installer-<versione>.exe` dell'ultima versione.
3. Avviarlo e seguire le istruzioni. L'installazione è per l'utente corrente e non richiede i permessi di
   amministratore.

Serve Windows 10 o Windows 11 a 64 bit.

<!-- image: the installation window -->

## Requisiti in breve

- Windows 10 o 11 a 64 bit
- una scheda grafica con WebGL 2 (va bene qualsiasi scheda recente, integrata o dedicata)
- memoria: almeno 8 GB, 16 GB consigliati, 32 GB o più per sensori full frame con molti frame
- circa 380 MB di spazio per il programma, più pochi MB per ogni catalogo facoltativo

I dettagli, compreso il numero di frame che si possono impilare in base alla memoria, sono in
[docs/requirements.md](docs/requirements.md) (in inglese).

## Privacy

- Nessun account, nessuna statistica d'uso, nessun dato diagnostico inviato, nessuna pubblicità.
- Le immagini restano sul computer e StarLight non le invia mai in rete.
- Internet si usa solo se permesso (Impostazioni, scheda Rete e cataloghi) e solo per tre scopi: controllare e
  scaricare gli aggiornamenti, scaricare i cataloghi scelti, interrogare il catalogo Gaia per la calibrazione del
  colore e la risoluzione astrometrica. In quest'ultimo caso si inviano solo le coordinate del centro dell'immagine.
- Impostazioni, copie di recupero, cataloghi e registro degli errori sono salvati in `%APPDATA%\StarLight`.

Il testo completo è nella finestra Informazioni su StarLight del programma, sezione «Privacy e dati».

## Compilare dai sorgenti

Servono Windows 10 o 11 a 64 bit e [Node.js](https://nodejs.org/) 22.

```
npm install        installa le dipendenze
npm run dev        avvia StarLight in modalità sviluppo, con ricaricamento automatico
npm run test       esegue il controllo dei tipi e tutte le verifiche automatiche
npm run dist       esegue le verifiche rapide e costruisce l'installer e la versione portatile in dist-build
```

`npm run test -- --list` mostra l'elenco delle verifiche, `npm run test -- --only plugin` ne esegue solo alcune,
`npm run test -- --quick` salta quelle lente.

Alcune verifiche lavorano su immagini reali e frame di prova che non fanno parte del progetto. Per eseguirle servono una
cartella con quei file e un file `test-data.json` che abbina ogni ruolo usato dalle verifiche (per esempio `m27` o
`synthetic-frames`) al percorso relativo del file o della cartella; la cartella si indica con la variabile d'ambiente
`STARLIGHT_TEST_DATA`. Se la cartella manca, quelle verifiche vengono saltate e non contano come fallite. I dettagli
sono in [docs/testing.md](docs/testing.md) (in inglese).

## Contribuire

- **Segnalazioni di errori**: gli errori si segnalano nella sezione Issues. Aiuta allegare il registro degli errori, che
  si copia dal menu Aiuto e in cui il nome utente compare già sostituito da `%USERPROFILE%`.
- **Plugin**: nuovi strumenti scritti in JavaScript, eseguiti isolati dal resto del programma. La guida completa è in
  [docs/plugin.md](docs/plugin.md) (in inglese).
- **Cataloghi**: cataloghi di oggetti con dati a licenza aperta. La guida è in [docs/catalogs.md](docs/catalogs.md)
  (in inglese).
- **Traduzioni**: StarLight è disponibile in italiano e in inglese. Aggiungere una lingua non richiede di programmare:
  la guida è in [docs/translating.md](docs/translating.md) (in inglese). Le offerte di aiuto per altre lingue sono
  benvenute nella sezione Issues.

## Licenza

StarLight è distribuito con la [GNU General Public License versione 3 o successiva](LICENSE) (GPL-3.0-or-later). Si può
usare, studiare, modificare e ridistribuire alle sue condizioni. Il programma è fornito senza alcuna garanzia.

## Riconoscimenti

StarLight usa opere di altri autori, fra cui il catalogo OpenNGC, ciascuna con la propria licenza. L'elenco completo è
nella finestra **Licenza e riconoscimenti** (menu Aiuto) e nel file [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Sostegno

StarLight è gratuito e lo resterà. Chi desidera sostenerne lo sviluppo può dare un contributo su
[Ko-fi](https://ko-fi.com/fmdigitaltools).

## Contatti

StarLight è sviluppato da FM Digital Tools. Domande, suggerimenti e segnalazioni sono benvenuti nella sezione
[Issues](../../issues). Altre informazioni su StarLight su [fmdigitaltools.com](https://fmdigitaltools.com/).
