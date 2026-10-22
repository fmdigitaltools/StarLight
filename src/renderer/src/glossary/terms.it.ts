/**
 * Italian glossary entries. Same order and structure as `terms.en.ts`;
 * see `terms.ts` for the types and the editing rules.
 */

import type { GlossaryEntry } from './terms'

export const TERMS_IT: GlossaryEntry[] = [
  // ---------------------------------------------------------------- Capture and sensor
  {
    term: 'Frame di luce',
    alternatives: ['light', 'light frame', 'frame', 'scatto', 'sub-frame', 'subframe', 'posa singola'],
    category: 'capture',
    definition:
      'Singola esposizione del cielo, cioè dell’oggetto da riprendere. In astrofotografia una ripresa è composta di norma da decine o centinaia di frame di luce di pochi secondi o minuti ciascuno, che vengono poi calibrati, allineati e sommati. Ogni frame contiene, oltre al segnale dell’oggetto, il rumore e i difetti del sensore.',
    inStarLight:
      'I frame di luce si caricano nel passo Importa, singolarmente o per cartella, e compaiono nella libreria. StarLight li riconosce dalla parola chiave IMAGETYP dell’intestazione e dal nome del file. Nel passo Impila vengono misurati, eventualmente calibrati con i master, allineati e combinati in un’unica immagine.',
    see: ['Frame di calibrazione', 'Impilamento', 'IMAGETYP', 'Libreria dei frame']
  },
  {
    term: 'Posa',
    alternatives: ['esposizione', 'tempo di posa', 'tempo di esposizione', 'EXPTIME', 'EXPOSURE', 'exposure'],
    category: 'capture',
    definition:
      'Durata dell’esposizione di un singolo frame, espressa in secondi. Una posa più lunga raccoglie più luce per frame, ma accumula anche più segnale termico, aumenta il rischio di stelle mosse e porta più rapidamente al bianco le stelle luminose.',
    inStarLight:
      'La posa è letta dall’intestazione del file e mostrata nel passo Importa alla voce Esposizione. La libreria di calibrazione la usa per scegliere il master dark adatto, che deve avere la stessa posa dei frame di luce.',
    see: ['Integrazione totale', 'Dark', 'Libreria di calibrazione']
  },
  {
    term: 'Integrazione totale',
    alternatives: ['tempo di integrazione', 'integrazione', 'esposizione totale'],
    category: 'capture',
    definition:
      'Somma delle pose di tutti i frame che compongono un’immagine impilata. È l’indicatore principale della profondità di una ripresa: a parità di condizioni, raddoppiare l’integrazione migliora il rapporto segnale/rumore di circa il 41%.',
    inStarLight:
      'Per i file già impilati il passo Importa mostra il numero di frame integrati e l’integrazione totale, quando l’intestazione li riporta.',
    see: ['Posa', 'Rapporto segnale/rumore', 'Immagine già impilata']
  },
  {
    term: 'Sensore',
    alternatives: ['CMOS', 'CCD', 'camera', 'chip'],
    category: 'capture',
    definition:
      'Componente elettronico che converte la luce in un segnale misurabile. È formato da una griglia di pixel, ciascuno dei quali accumula una carica proporzionale ai fotoni ricevuti durante la posa. Le camere astronomiche e le fotocamere moderne usano quasi sempre sensori CMOS; i CCD sono diffusi negli strumenti meno recenti.',
    inStarLight:
      'Le caratteristiche del sensore dichiarate nell’intestazione (dimensioni, dimensione dei pixel, matrice di Bayer, guadagno, temperatura) vengono usate per ricostruire il colore, calcolare la scala del campo e scegliere i master di calibrazione compatibili.',
    see: ['Pixel', 'Matrice di Bayer', 'Guadagno', 'Temperatura del sensore']
  },
  {
    term: 'Pixel',
    alternatives: ['dimensione dei pixel', 'pixel size', 'XPIXSZ', 'micron', 'µm'],
    category: 'capture',
    definition:
      'Elemento sensibile del sensore e, nell’immagine, il più piccolo punto dotato di un valore. La dimensione fisica del pixel, espressa in micrometri (µm), insieme alla focale determina quanta porzione di cielo ciascun pixel raccoglie.',
    inStarLight:
      'La dimensione dei pixel è letta dall’intestazione (parole chiave come XPIXSZ o PIXSIZE) e serve a calcolare la scala del campo. Il passo Importa mostra larghezza e altezza in pixel di ogni frame.',
    see: ['Scala del campo', 'Focale', 'Binning']
  },
  {
    term: 'Binning',
    alternatives: ['XBINNING', 'bin 2x2'],
    category: 'capture',
    definition:
      'Raggruppamento di più pixel adiacenti del sensore, per esempio 2 × 2, che vengono letti come un unico pixel più grande. Riduce la risoluzione e aumenta il segnale per pixel.',
    inStarLight:
      'Il fattore di binning dichiarato nell’intestazione viene moltiplicato per la dimensione dei pixel nel calcolo della scala del campo.',
    see: ['Pixel', 'Scala del campo']
  },
  {
    term: 'Focale',
    alternatives: ['lunghezza focale', 'distanza focale', 'FOCALLEN', 'focal length'],
    category: 'capture',
    definition:
      'Distanza, espressa in millimetri, fra l’obiettivo o lo specchio principale e il piano in cui si forma l’immagine. A parità di sensore, una focale più lunga ingrandisce di più e inquadra un campo più ristretto.',
    inStarLight:
      'La focale è letta dall’intestazione e, insieme alla dimensione dei pixel, permette di calcolare la scala del campo, usata anche dalla risoluzione del campo come indizio di partenza.',
    see: ['Scala del campo', 'Pixel', 'Campo inquadrato']
  },
  {
    term: 'Guadagno',
    alternatives: ['gain', 'GAIN', 'ISO', 'sensibilità'],
    category: 'capture',
    definition:
      'Amplificazione applicata dal sensore al segnale prima della conversione in numeri. Corrisponde, nelle fotocamere, alla sensibilità ISO. Un guadagno più alto rende più luminoso il segnale debole e riduce il peso del rumore di lettura, ma restringe la gamma dinamica. Dark e bias valgono solo per il guadagno con cui sono stati ripresi.',
    inStarLight:
      'Il guadagno è letto dall’intestazione e mostrato nel passo Importa. La libreria di calibrazione riusa un master dark o un master bias soltanto se il guadagno coincide con quello dei frame di luce. Da non confondere con i cursori Guadagno rosso, verde e blu del passo Correggi, che regolano il bilanciamento dei colori.',
    see: ['Dark', 'Bias', 'Guadagni dei canali', 'Libreria di calibrazione']
  },
  {
    term: 'Temperatura del sensore',
    alternatives: ['CCD-TEMP', 'SET-TEMP', 'raffreddamento', 'temperatura'],
    category: 'capture',
    definition:
      'Temperatura del sensore durante la ripresa, in gradi Celsius. Il segnale termico raddoppia all’incirca ogni 5-6 °C, quindi un dark è valido solo per frame di luce ripresi a una temperatura molto vicina. Le camere raffreddate mantengono il sensore a una temperatura fissa proprio per questo motivo.',
    inStarLight:
      'La temperatura è letta dall’intestazione e mostrata nel passo Importa. La libreria di calibrazione riusa un master dark solo se la sua temperatura non differisce di oltre 3 °C da quella dei frame di luce e, fra più dark adatti, sceglie quello più vicino per temperatura.',
    see: ['Segnale termico', 'Dark', 'Libreria di calibrazione']
  },
  {
    term: 'Rumore',
    alternatives: ['grana', 'noise', 'disturbo'],
    category: 'capture',
    definition:
      'Variazione casuale dei valori dei pixel che si sovrappone al segnale vero. Ha più origini: la natura discreta della luce (rumore fotonico), l’elettronica di lettura (rumore di lettura) e il calore del sensore (rumore termico). Poiché è casuale, cambia da un frame all’altro e si attenua sommando molti frame.',
    inStarLight:
      'Il passo Importa riporta una stima del rumore di ogni frame, calcolata con statistiche robuste poco influenzate dalle stelle. Il rumore si riduce con l’impilamento e, sull’immagine, con gli strumenti NL-Bayes e Ondine del passo Elabora, con la riduzione del rumore del passo Filtri e con le regolazioni locali.',
    see: ['Rapporto segnale/rumore', 'Rumore di lettura', 'Riduzione del rumore', 'Impilamento']
  },
  {
    term: 'Rumore di lettura',
    alternatives: ['read noise', 'rumore elettronico'],
    category: 'capture',
    definition:
      'Componente del rumore introdotta dall’elettronica del sensore a ogni lettura, indipendentemente dalla durata della posa. Pesa di più nelle pose brevi e con segnale molto debole.',
    inStarLight:
      'Non viene corretto direttamente, perché è casuale: si attenua con l’impilamento. Il livello fisso di lettura, che invece è costante, viene misurato dal bias o è già compreso nel dark.',
    see: ['Rumore', 'Bias', 'Impilamento']
  },
  {
    term: 'Segnale termico',
    alternatives: ['corrente di buio', 'dark current', 'rumore termico', 'segnale di buio'],
    category: 'capture',
    definition:
      'Segnale prodotto dal calore del sensore anche in assenza di luce. Cresce con la durata della posa e con la temperatura e non è uniforme: alcuni pixel ne producono molto più degli altri. La parte costante si sottrae con il dark; la parte casuale si attenua con l’impilamento.',
    inStarLight:
      'Il segnale termico viene sottratto dai frame di luce con il master dark durante l’impilamento, quando la calibrazione è attiva.',
    see: ['Dark', 'Master dark', 'Pixel caldi', 'Temperatura del sensore']
  },
  {
    term: 'Rapporto segnale/rumore',
    alternatives: ['SNR', 'S/N', 'signal to noise ratio', 'segnale rumore'],
    category: 'capture',
    definition:
      'Rapporto fra l’intensità del segnale utile e l’ampiezza del rumore. È la misura principale della qualità di un’immagine astronomica: un rapporto alto consente di distendere i toni deboli senza far emergere la grana. Sommando N frame il rapporto migliora in proporzione alla radice quadrata di N: quattro volte i frame dimezzano il rumore relativo.',
    inStarLight:
      'Al termine dell’impilamento il passo Impila riporta la riduzione del rumore misurata, confrontando il rumore del frame di riferimento con quello del risultato, e quella attesa in base al numero di frame integrati.',
    see: ['Rumore', 'Impilamento', 'Integrazione totale']
  },
  {
    term: 'Pixel saturi',
    alternatives: ['saturazione del sensore', 'clipping', 'pixel bruciati', 'stelle bruciate', 'saturi'],
    category: 'capture',
    definition:
      'Pixel che hanno raggiunto il valore massimo misurabile. Oltre questo limite il sensore non registra più differenze di luminosità, quindi l’informazione è persa: i centri delle stelle luminose e i nuclei brillanti appaiono come zone uniformi. Il fenomeno non va confuso con la saturazione dei colori.',
    inStarLight:
      'Il passo Importa riporta la percentuale di pixel al massimo della scala. Le stelle sature vengono escluse dalla calibrazione fotometrica del colore. Il plugin HDR recupera il dettaglio delle zone luminose solo se è presente nei dati.',
    see: ['Gamma dinamica', 'HDR, recupero delle zone luminose', 'Saturazione']
  },
  {
    term: 'Gamma dinamica',
    alternatives: ['dynamic range', 'intervallo dinamico'],
    category: 'capture',
    definition:
      'Intervallo fra il segnale più debole distinguibile dal rumore e il segnale più intenso registrabile prima della saturazione. Gli oggetti astronomici ne richiedono una molto ampia: il nucleo di una galassia o di una nebulosa può essere migliaia di volte più luminoso delle sue regioni esterne.',
    inStarLight:
      'StarLight elabora i dati in virgola mobile a 32 bit, che conservano l’intera gamma dinamica dei file. La distensione, la GHS e il plugin HDR comprimono la gamma dinamica in modo che toni deboli e zone luminose restino entrambi leggibili sullo schermo.',
    see: ['Profondità di bit', 'Distensione', 'HDR, recupero delle zone luminose']
  },
  {
    term: 'Matrice di Bayer',
    alternatives: ['Bayer', 'CFA', 'color filter array', 'schema di Bayer', 'RGGB', 'GRBG', 'BGGR', 'GBRG', 'BAYERPAT'],
    category: 'capture',
    definition:
      'Griglia di filtri rossi, verdi e blu posta davanti ai pixel di un sensore a colori, ripetuta in celle di 2 × 2 pixel con due verdi, un rosso e un blu. Ogni pixel misura un solo colore; gli altri due vengono ricostruiti dai pixel vicini. L’ordine dei filtri nella cella (per esempio RGGB o GRBG) cambia da sensore a sensore.',
    inStarLight:
      'Lo schema è letto dall’intestazione del file (parola chiave BAYERPAT o equivalenti) ed è mostrato nel passo Importa. StarLight lo usa per ricostruire il colore dei frame grezzi e per il Bayer drizzle.',
    see: ['Ricostruzione del colore', 'Bayer drizzle', 'X-Trans', 'Sensore a colori']
  },
  {
    term: 'X-Trans',
    alternatives: ['schema X-Trans'],
    category: 'capture',
    definition:
      'Disposizione dei filtri colorati usata da alcune fotocamere, alternativa alla matrice di Bayer: lo schema si ripete in celle di 6 × 6 pixel invece che di 2 × 2.',
    inStarLight:
      'I file RAW con sensore X-Trans vengono letti e il loro colore viene ricostruito con un procedimento dedicato a questo schema.',
    see: ['Matrice di Bayer', 'RAW', 'Ricostruzione del colore']
  },
  {
    term: 'Ricostruzione del colore',
    alternatives: ['debayer', 'debayering', 'demosaicizzazione', 'demosaicing', 'interpolazione di Bayer'],
    category: 'capture',
    definition:
      'Calcolo che, a partire dai dati grezzi di un sensore a colori, stima per ogni pixel i due colori non misurati usando i pixel vicini, e produce un’immagine con tre canali completi. L’interpolazione tende ad ammorbidire leggermente le stelle e può lasciare sottili frange colorate sui bordi.',
    inStarLight:
      'I frame grezzi dei sensori a colori vengono ricostruiti con un’interpolazione bilineare, che conserva in ogni pixel il valore effettivamente misurato. In alternativa, nel passo Impila, il Bayer drizzle evita l’interpolazione e usa solo i colori misurati.',
    see: ['Matrice di Bayer', 'Bayer drizzle', 'Sensore a colori']
  },
  {
    term: 'Sensore a colori',
    alternatives: ['OSC', 'one shot color', 'sensore monocromatico', 'mono', 'camera a colori'],
    category: 'capture',
    definition:
      'Sensore dotato di matrice di filtri colorati, che produce un’immagine a colori in un solo scatto. Il sensore monocromatico, privo di filtri sui pixel, registra solo la luminosità e ottiene il colore riprendendo lo stesso campo con filtri diversi, montati davanti al sensore uno alla volta.',
    inStarLight:
      'StarLight elabora sia i frame dei sensori a colori, ricostruendone il colore dalla matrice di Bayer o X-Trans, sia i frame monocromatici, che restano a un solo canale.',
    see: ['Matrice di Bayer', 'Ricostruzione del colore', 'Canale di colore']
  },
  {
    term: 'Vignettatura',
    alternatives: ['vignetting', 'caduta di luce ai bordi'],
    category: 'capture',
    definition:
      'Diminuzione graduale della luminosità dal centro verso i bordi e gli angoli dell’immagine, causata dall’ottica e dagli elementi meccanici sul percorso della luce. In fotografia artistica lo stesso termine indica anche un effetto applicato di proposito per scurire i bordi e portare l’attenzione sul soggetto.',
    inStarLight:
      'La vignettatura ottica viene corretta con il master flat durante la calibrazione. Il passo Filtri contiene invece una vignettatura artistica, che scurisce gradualmente bordi e angoli lasciando intatto il centro; con un ritaglio impostato si centra sulla parte esportata.',
    see: ['Flat', 'Master flat', 'Filtro fotografico']
  },
  {
    term: 'Seeing',
    alternatives: ['turbolenza atmosferica', 'turbolenza'],
    category: 'capture',
    definition:
      'Degrado dell’immagine dovuto alla turbolenza dell’atmosfera, che fa tremolare e allarga le stelle. Si misura di solito con la FWHM delle stelle in secondi d’arco e varia da una notte all’altra e nel corso della stessa notte.',
    inStarLight:
      'Gli effetti del seeing si leggono nell’HFR dei frame, mostrato nel passo Impila: i frame con stelle più larghe ricevono un punteggio di qualità più basso. La deconvoluzione recupera in parte la nitidezza attenuata.',
    see: ['HFR', 'FWHM', 'Qualità del frame', 'Deconvoluzione']
  },
  {
    term: 'Aberrazione cromatica',
    alternatives: ['frangia colorata', 'frange colorate', 'alone viola', 'alone blu', 'cromatismo', 'chromatic aberration'],
    category: 'capture',
    definition:
      'Difetto delle lenti, che non portano tutti i colori nello stesso fuoco. Nell’aberrazione longitudinale il blu e il violetto si concentrano in un disco più largo del verde e formano attorno alle stelle un alone viola o blu, tipico dei rifrattori a due lenti e degli obiettivi fotografici. Nell’aberrazione laterale i colori si spostano l’uno rispetto all’altro verso i bordi del campo, e le stelle mostrano una frangia rossa da un lato e verde o blu dall’altro.',
    inStarLight:
      'Il plugin Rimozione degli aloni viola e blu misura il colore di ogni stella nella sua parte interna e sottrae dal bordo la luce colorata in eccesso; con la tinta «Tutte le tinte» corregge anche le frange dell’aberrazione laterale.',
    see: ['Rimozione degli aloni viola e blu', 'Alone delle stelle']
  },
  {
    term: 'Alone delle stelle',
    alternatives: ['alone', 'aloni', 'halo', 'riflessi interni', 'alone luminoso', 'bagliore delle stelle'],
    category: 'capture',
    definition:
      'Luce diffusa attorno a una stella, molto più estesa del suo disco. Attorno alle stelle brillanti un alone largo e tenue nasce dalla foschia o da nubi sottili, dai riflessi fra le superfici di lenti e filtri e dalla diffusione nell’ottica; un alone colorato e più stretto è invece di solito un effetto dell’aberrazione cromatica.',
    inStarLight:
      'Il plugin Riduzione degli aloni delle stelle brillanti attenua l’alone largo delle stelle più luminose; il plugin Rimozione degli aloni viola e blu toglie la frangia colorata dovuta all’aberrazione cromatica.',
    see: ['Riduzione degli aloni delle stelle brillanti', 'Aberrazione cromatica', 'Gradiente']
  },
  {
    term: 'Inquinamento luminoso',
    alternatives: ['light pollution', 'cielo urbano'],
    category: 'capture',
    definition:
      'Luce artificiale diffusa dall’atmosfera, che rischiara il cielo notturno e aggiunge all’immagine un fondo luminoso, spesso colorato e non uniforme. Riduce il contrasto degli oggetti deboli e aumenta il rumore.',
    inStarLight:
      'Gli effetti dell’inquinamento luminoso si correggono con l’estrazione del fondo cielo del passo Elabora, con la rimozione del fondo del passo Filtri e con i guadagni dei canali del passo Correggi.',
    see: ['Fondo cielo', 'Gradiente', 'Estrazione del fondo cielo', 'Filtro antinquinamento luminoso']
  },
  {
    term: 'Filtro',
    alternatives: ['filtro ottico', 'filtro astronomico', 'FILTER', 'ruota portafiltri'],
    category: 'capture',
    definition:
      'Elemento ottico posto sul percorso della luce che lascia passare solo alcune lunghezze d’onda. In astrofotografia si usano filtri che bloccano l’infrarosso, filtri che attenuano l’inquinamento luminoso e filtri a banda stretta che isolano le righe di emissione di alcuni gas.',
    inStarLight:
      'Il filtro dichiarato nell’intestazione (parola chiave FILTER) è mostrato nel passo Importa. StarLight lo usa per riconoscere le riprese con filtro a doppia banda e per abbinare i master flat, che vengono riusati dalla libreria solo con lo stesso filtro. Da non confondere con i filtri fotografici del passo Filtri.',
    see: ['Filtro IRCUT', 'Filtro antinquinamento luminoso', 'Filtro a doppia banda', 'Banda stretta', 'Filtro fotografico']
  },
  {
    term: 'Filtro IRCUT',
    alternatives: ['IR-cut', 'IRCUT', 'UV/IR cut', 'filtro anti-infrarosso', 'banda larga'],
    category: 'capture',
    definition:
      'Filtro che blocca l’infrarosso e l’ultravioletto e lascia passare tutta la luce visibile. Evita che le stelle appaiano gonfie o colorate in modo anomalo per effetto delle lunghezze d’onda che l’ottica non mette a fuoco. Una ripresa con questo filtro si dice a banda larga.',
    inStarLight:
      'Un file con filtro IRCUT, o senza indicazione di filtro, è trattato come ripresa a banda larga: la calibrazione fotometrica del colore e le tavolozze naturali si applicano normalmente.',
    see: ['Filtro', 'Calibrazione fotometrica del colore']
  },
  {
    term: 'Filtro antinquinamento luminoso',
    alternatives: ['LP', 'light pollution filter', 'filtro LP', 'filtro antinquinamento'],
    category: 'capture',
    definition:
      'Filtro che attenua le lunghezze d’onda tipiche dell’illuminazione artificiale e lascia passare quelle emesse dalle nebulose. Alcuni modelli sono a banda moderatamente larga, altri sono veri filtri a doppia banda. Tende a lasciare una dominante di colore sul fondo, spesso verdastra o rossastra.',
    inStarLight:
      'Nell’intestazione i valori LP, DUO o DUAL della parola chiave FILTER vengono interpretati come filtro a doppia banda: il passo Elabora propone allora la tavolozza HOO. La dominante residua si corregge con i guadagni dei canali del passo Correggi.',
    see: ['Filtro a doppia banda', 'Dominante di colore', 'Inquinamento luminoso']
  },
  {
    term: 'Filtro a doppia banda',
    alternatives: ['dual band', 'duo band', 'DUAL', 'DUO', 'filtro duale', 'doppia banda'],
    category: 'capture',
    definition:
      'Filtro a banda stretta per sensori a colori che lascia passare solo due righe di emissione, di norma l’idrogeno (H-alfa) e l’ossigeno (OIII). Con un sensore a colori l’H-alfa finisce nel canale rosso, l’OIII nei canali verde e blu.',
    inStarLight:
      'Quando l’intestazione indica questo filtro, la scheda Banda stretta del passo Elabora lo segnala e consiglia la tavolozza HOO. La scheda separa le due righe dai canali del sensore e le ricompone secondo la tavolozza scelta. La calibrazione fotometrica del colore non è significativa su queste riprese.',
    see: ['Banda stretta', 'H-alfa', 'OIII', 'HOO', 'Tavolozza']
  },
  {
    term: 'Banda stretta',
    alternatives: ['narrowband', 'narrow band', 'filtri a banda stretta'],
    category: 'capture',
    definition:
      'Tecnica di ripresa con filtri che lasciano passare solo intervalli molto ristretti di lunghezze d’onda, corrispondenti alle righe di emissione di alcuni gas, come l’idrogeno (H-alfa), l’ossigeno (OIII) e lo zolfo (SII). Riduce fortemente l’effetto dell’inquinamento luminoso e della Luna ed è adatta alle nebulose a emissione. I colori finali sono assegnati per convenzione.',
    inStarLight:
      'La scheda Banda stretta del passo Elabora tratta le riprese con filtro a doppia banda: separa idrogeno e ossigeno e le ricompone con le tavolozze HOO, Foraxx e Hubble sintetica, con cursori per l’equilibrio fra i due gas e l’intensità dell’ossigeno.',
    see: ['Filtro a doppia banda', 'H-alfa', 'OIII', 'SII', 'Tavolozza']
  },
  {
    term: 'H-alfa',
    alternatives: ['Hα', 'Ha', 'H-alpha', 'idrogeno alfa', 'idrogeno'],
    category: 'capture',
    definition:
      'Riga di emissione dell’idrogeno a 656,3 nanometri, nel rosso. È la luce dominante della maggior parte delle nebulose a emissione e conferisce loro il tipico colore rosso.',
    inStarLight:
      'Nelle riprese con filtro a doppia banda l’H-alfa viene estratta dal canale rosso. Le regolazioni locali offrono una maschera di colore già pronta per il rosso dell’idrogeno.',
    see: ['Banda stretta', 'OIII', 'Nebulosa a emissione', 'Maschera']
  },
  {
    term: 'OIII',
    alternatives: ['O III', 'O3', 'ossigeno', 'ossigeno ionizzato', 'ossigeno doppiamente ionizzato'],
    category: 'capture',
    definition:
      'Righe di emissione dell’ossigeno doppiamente ionizzato, a 495,9 e 500,7 nanometri, al confine fra il verde e il blu. Sono intense nelle nebulose planetarie e nei resti di supernova, più deboli dell’H-alfa nella maggior parte delle nebulose.',
    inStarLight:
      'Nelle riprese con filtro a doppia banda l’OIII viene ricavata dai canali verde e blu. Il cursore Intensità OIII della scheda Banda stretta la rinforza o la attenua; le regolazioni locali offrono una maschera di colore per l’azzurro dell’ossigeno.',
    see: ['Banda stretta', 'H-alfa', 'HOO']
  },
  {
    term: 'SII',
    alternatives: ['S II', 'S2', 'zolfo', 'zolfo ionizzato'],
    category: 'capture',
    definition:
      'Riga di emissione dello zolfo ionizzato a 671,6 nanometri, nel rosso profondo. Si riprende con un filtro dedicato, di solito con sensori monocromatici, ed è una delle tre componenti della tavolozza SHO.',
    inStarLight:
      'I filtri a doppia banda non raccolgono lo zolfo: per questo la tavolozza Hubble di StarLight è sintetica e usa di nuovo l’idrogeno al posto dello zolfo.',
    see: ['Banda stretta', 'Tavolozza Hubble']
  },
  {
    term: 'Rotazione di campo',
    alternatives: ['field rotation', 'rotazione del campo', 'montatura altazimutale'],
    category: 'capture',
    definition:
      'Rotazione progressiva dell’immagine del cielo attorno al centro del campo, tipica delle montature altazimutali, che inseguono il cielo muovendosi in altezza e in azimut invece che attorno a un asse parallelo a quello terrestre. Nelle pose lunghe deforma le stelle ai bordi; fra un frame e l’altro fa ruotare l’inquadratura.',
    inStarLight:
      'L’allineamento misura per ogni frame anche la rotazione e la compensa. Ai bordi del risultato restano zone coperte da pochi frame, più rumorose: l’opzione Ritaglia i bordi coperti da pochi frame del passo Impila propone il ritaglio che le esclude.',
    see: ['Allineamento', 'Bordi a bassa copertura', 'Montatura']
  },
  {
    term: 'Montatura',
    alternatives: ['montatura equatoriale', 'montatura altazimutale', 'inseguimento', 'tracking'],
    category: 'capture',
    definition:
      'Supporto motorizzato che orienta il telescopio e ne compensa la rotazione terrestre durante la ripresa. La montatura equatoriale ruota attorno a un asse parallelo a quello terrestre e mantiene fisso l’orientamento del campo; quella altazimutale si muove in altezza e azimut e produce la rotazione di campo.',
    inStarLight:
      'StarLight non comanda la montatura. Ne corregge gli effetti sui frame: spostamenti e rotazioni vengono compensati dall’allineamento, i frame mossi ricevono un punteggio di qualità basso.',
    see: ['Rotazione di campo', 'Allineamento', 'Qualità del frame']
  },
  {
    term: 'Fuocheggiatore',
    alternatives: ['focheggiatore', 'focuser', 'FOCPOS', 'messa a fuoco'],
    category: 'capture',
    definition:
      'Meccanismo che sposta il sensore o un elemento ottico per mettere a fuoco l’immagine. I fuocheggiatori motorizzati registrano la propria posizione in passi del motore.',
    inStarLight:
      'La posizione del fuocheggiatore, se presente nell’intestazione, è mostrata nel passo Importa e serve a ritrovare la messa a fuoco in sessioni successive. Una messa a fuoco imperfetta si riconosce da un HFR più alto.',
    see: ['HFR', 'Qualità del frame']
  },

  // ---------------------------------------------------------------- Calibration
  {
    term: 'Calibrazione',
    alternatives: ['calibrazione dei frame', 'pre-elaborazione', 'calibration'],
    category: 'calibration',
    definition:
      'Correzione dei frame di luce mediante i frame di calibrazione, che misurano i difetti propri del sensore e dell’ottica. La formula consueta sottrae il dark (o, in sua assenza, il bias) e divide il risultato per il flat normalizzato. La calibrazione si esegue prima dell’allineamento e della somma.',
    inStarLight:
      'Il passo Calibra divide automaticamente i dark, i flat e i bias presenti nella libreria in gruppi con le stesse condizioni di ripresa (i dark per posa, guadagno e temperatura entro 3 °C; i bias per guadagno; i flat per filtro e notte) e compone un master per ogni gruppo; un frame rimasto solo in un gruppo viene escluso, con la spiegazione. Con l’interruttore Applica la calibrazione durante l’impilamento acceso, nel passo Impila ogni frame di luce usa il master con le sue condizioni, oppure quello della libreria di calibrazione: sottrazione del dark, divisione per il flat normalizzato, sottrazione del bias quando manca un dark adatto, sostituzione dei pixel difettosi. Un dark di posa, guadagno o temperatura diversi non viene mai usato; il riepilogo dell’impilamento indica, per ogni gruppo di frame di luce, i master usati e il motivo.',
    see: ['Frame di calibrazione', 'Master', 'Dark', 'Flat', 'Bias', 'Libreria di calibrazione']
  },
  {
    term: 'Frame di calibrazione',
    alternatives: ['calibration frame', 'frame di correzione'],
    category: 'calibration',
    definition:
      'Scatti che non riprendono il cielo ma misurano i difetti del sistema di ripresa: il dark registra il segnale termico e i pixel caldi, il flat la vignettatura e le ombre della polvere, il bias il livello di partenza della lettura. Vanno ripresi con lo stesso sensore e con impostazioni coerenti con quelle dei frame di luce.',
    inStarLight:
      'StarLight riconosce il tipo di ogni frame dalla parola chiave IMAGETYP e dal nome del file, li raggruppa nel passo Calibra e li combina nei rispettivi master.',
    see: ['Dark', 'Flat', 'Bias', 'Master', 'IMAGETYP']
  },
  {
    term: 'Dark',
    alternatives: ['dark frame', 'frame di buio', 'scatto al buio'],
    category: 'calibration',
    definition:
      'Frame ripreso con il telescopio coperto, con la stessa posa, lo stesso guadagno e alla stessa temperatura dei frame di luce. Registra il segnale termico del sensore, il livello di lettura e i pixel caldi: difetti identici in ogni scatto, che la somma dei frame da sola non elimina.',
    inStarLight:
      'I dark presenti nella libreria vengono combinati nel master dark nel passo Calibra. Un singolo file riconosciuto come dark è considerato già un master e viene usato così com’è.',
    see: ['Master dark', 'Segnale termico', 'Pixel caldi', 'Dark dei flat']
  },
  {
    term: 'Master',
    alternatives: ['master frame', 'frame master', 'master di calibrazione'],
    category: 'calibration',
    definition:
      'Frame di riferimento ottenuto combinando molti frame di calibrazione dello stesso tipo. La combinazione attenua il rumore casuale dei singoli scatti e lascia il solo difetto sistematico da correggere: un master composto da molti frame introduce meno rumore nei frame di luce.',
    inStarLight:
      'Nel passo Calibra i frame di ciascun tipo vengono combinati con la mediana, che elimina anche i disturbi presenti in un solo scatto, come i raggi cosmici. I master composti vengono conservati nella libreria di calibrazione per le sessioni successive.',
    see: ['Master dark', 'Master flat', 'Master bias', 'Mediana', 'Libreria di calibrazione']
  },
  {
    term: 'Master dark',
    alternatives: ['dark master', 'masterdark'],
    category: 'calibration',
    definition:
      'Combinazione di molti dark in un unico frame che rappresenta il segnale termico e il livello di lettura del sensore per una data posa, guadagno e temperatura. Viene sottratto da ogni frame di luce. Alcuni telescopi e programmi di ripresa producono il master dark direttamente.',
    inStarLight:
      'StarLight compone il master dark con la mediana dei dark, conta i pixel difettosi (quelli che al buio registrano molta più luce della media) e lo sottrae da ogni frame di luce durante l’impilamento. Gli stessi pixel difettosi vengono poi sostituiti con la mediana dei pixel vicini. Un master dark già prodotto dal telescopio si importa come un file qualsiasi ed è riconosciuto automaticamente.',
    see: ['Dark', 'Pixel caldi', 'Mediana', 'Libreria di calibrazione']
  },
  {
    term: 'Bias',
    alternatives: ['bias frame', 'offset', 'frame di offset', 'zero'],
    category: 'calibration',
    definition:
      'Frame ripreso al buio con la posa più breve possibile. Registra il livello di partenza della lettura, cioè il valore che il sensore riporta anche in assenza di luce e di segnale termico. Il dark contiene già questo livello, quindi il bias serve quando i dark mancano o per correggere i flat.',
    inStarLight:
      'I bias vengono combinati nel master bias. StarLight lo sottrae dai frame di luce solo quando non è disponibile un master dark, e lo usa per correggere il master flat quando manca un dark della stessa posa dei flat.',
    see: ['Master bias', 'Dark', 'Master flat', 'Rumore di lettura']
  },
  {
    term: 'Master bias',
    alternatives: ['bias master', 'masterbias'],
    category: 'calibration',
    definition:
      'Combinazione di molti bias in un unico frame che rappresenta il livello di lettura del sensore per un dato guadagno.',
    inStarLight:
      'Viene composto con la mediana nel passo Calibra e conservato nella libreria di calibrazione, che lo riusa con lo stesso sensore e lo stesso guadagno.',
    see: ['Bias', 'Master', 'Libreria di calibrazione']
  },
  {
    term: 'Flat',
    alternatives: ['flat field', 'flat frame', 'campo piatto', 'frame di campo piatto'],
    category: 'calibration',
    definition:
      'Frame ripreso puntando lo strumento verso una superficie illuminata in modo uniforme, senza modificare messa a fuoco, orientamento della camera e filtro rispetto ai frame di luce. Misura la diversa risposta delle varie zone del sensore: vignettatura, ombre della polvere e differenze di sensibilità fra i pixel.',
    inStarLight:
      'I flat vengono combinati nel master flat nel passo Calibra. Durante l’impilamento ogni frame di luce viene diviso per il master flat normalizzato, così le zone meno illuminate vengono riportate alla luminosità corretta.',
    see: ['Master flat', 'Vignettatura', 'Ombre della polvere', 'Dark dei flat']
  },
  {
    term: 'Master flat',
    alternatives: ['flat master', 'masterflat'],
    category: 'calibration',
    definition:
      'Combinazione di molti flat in un unico frame, corretta del livello di lettura e normalizzata, cioè divisa per il proprio valore medio, in modo che la divisione corregga le disuniformità senza cambiare la luminosità complessiva dell’immagine.',
    inStarLight:
      'StarLight compone il master flat con la mediana e, prima di conservarlo, sottrae un dark con la stessa posa dei flat preso dalla libreria oppure, in mancanza, il master bias. La normalizzazione sulla media avviene al momento della calibrazione.',
    see: ['Flat', 'Dark dei flat', 'Bias', 'Libreria di calibrazione']
  },
  {
    term: 'Dark dei flat',
    alternatives: ['flat dark', 'dark flat', 'darkflat'],
    category: 'calibration',
    definition:
      'Dark ripresi con la stessa posa e lo stesso guadagno dei flat. Servono a togliere dal master flat il livello di lettura e il segnale termico prima della normalizzazione; in loro assenza si usa di solito il bias.',
    inStarLight:
      'Quando compone un master flat, StarLight cerca nella libreria di calibrazione un master dark adatto alle condizioni dei flat e lo sottrae; se non lo trova usa il master bias. La libreria registra quale delle due correzioni è stata applicata.',
    see: ['Master flat', 'Dark', 'Bias', 'Libreria di calibrazione']
  },
  {
    term: 'Pixel caldi',
    alternatives: ['hot pixel', 'pixel difettosi', 'pixel freddi', 'pixel morti', 'cold pixel', 'difetti cosmetici'],
    category: 'calibration',
    definition:
      'Pixel che registrano un valore anomalo, molto più alto (caldi) o molto più basso (freddi o morti) di quelli circostanti, indipendentemente dalla luce ricevuta. Restano nella stessa posizione in ogni scatto, quindi l’impilamento da solo non li elimina e nell’immagine finale formano punti isolati o brevi tratti colorati.',
    inStarLight:
      'Durante la calibrazione i pixel caldi vengono individuati nel master dark e sostituiti con la mediana degli otto pixel vicini. Indipendentemente dai dark, l’opzione Correggi i pixel difettosi della scheda Difetti e fondo cielo del passo Elabora sostituisce i punti isolati anomali con la mediana dei vicini, senza toccare le stelle.',
    see: ['Master dark', 'Mediana', 'Segnale termico']
  },
  {
    term: 'Ombre della polvere',
    alternatives: ['polvere', 'ciambelle', 'dust donuts', 'anelli di polvere'],
    category: 'calibration',
    definition:
      'Ombre circolari o ad anello prodotte dai granelli di polvere depositati sui filtri o sulla finestra del sensore. Sono fuori fuoco, quindi appaiono come dischi sfumati, e cambiano posizione quando la polvere si sposta o la camera ruota.',
    inStarLight:
      'Si correggono con il master flat. La libreria di calibrazione riusa un flat solo se ripreso da non più di 30 giorni, perché una configurazione ottica cambiata introdurrebbe ombre non più presenti.',
    see: ['Flat', 'Master flat', 'Libreria di calibrazione']
  },
  {
    term: 'Libreria di calibrazione',
    alternatives: ['libreria dei master', 'archivio dei master', 'riuso dei master'],
    category: 'calibration',
    definition:
      'Archivio di master conservati da una sessione all’altra, che consente di calibrare nuove riprese senza riprendere ogni volta dark, flat e bias, a condizione che le condizioni di ripresa coincidano.',
    inStarLight:
      'I master composti nel passo Calibra restano sul computer, uno per ogni gruppo di condizioni, e vengono riusati automaticamente durante l’impilamento: un dark con lo stesso sensore, la stessa posa, lo stesso guadagno e una temperatura che non differisca di oltre 3 °C; un bias con lo stesso guadagno; un flat con lo stesso filtro e ripreso da non più di 30 giorni. Fra più dark adatti viene scelto il più vicino per temperatura e, a parità, il più recente; fra più flat adatti quello ripreso nella data più vicina a quella del frame, così ogni notte usa i propri flat. Le stesse regole valgono per i master composti nella sessione, che hanno la precedenza: la libreria serve ai frame che nella sessione non trovano un master con le loro condizioni. La scheda Libreria di calibrazione permette di disattivare il riuso e di eliminare i singoli master.',
    see: ['Master', 'Master dark', 'Master flat', 'Master bias', 'Temperatura del sensore']
  },

  // ---------------------------------------------------------------- Stacking
  {
    term: 'Impilamento',
    alternatives: ['stacking', 'stack', 'integrazione', 'somma dei frame', 'combinazione'],
    category: 'stacking',
    definition:
      'Combinazione di molti frame allineati in un’unica immagine. Il segnale dell’oggetto è uguale in ogni frame, mentre il rumore è casuale: combinando N frame il rumore relativo si riduce di un fattore pari alla radice quadrata di N. Con cento frame il rumore diventa dieci volte più basso.',
    inStarLight:
      'Il passo Impila misura i frame inclusi nella libreria, li calibra se richiesto, li allinea, scarta quelli sotto la qualità minima e li combina con il metodo scelto: Robusto, Media o Mediana. Il calcolo è diviso fra i nuclei del processore.',
    see: ['Allineamento', 'Scarto delle code', 'Media', 'Mediana', 'Rapporto segnale/rumore', 'Impilamento di più notti']
  },
  {
    term: 'Impilamento di più notti',
    alternatives: ['più sessioni', 'più serate', 'peso della notte', 'pesi delle notti', 'normalizzazione dei frame'],
    category: 'stacking',
    definition:
      'Combinazione in un’unica immagine di frame ripresi in notti diverse. Le notti differiscono per trasparenza del cielo, luminosità del fondo, turbolenza e temperatura: prima di combinarle i frame vanno riportati allo stesso livello di fondo e di luminosità, e ogni notte va pesata secondo la qualità dei propri dati. La pesatura classica assegna a ciascuna notte un peso inversamente proporzionale alla varianza del rumore, così le notti più pulite contano di più.',
    inStarLight:
      'StarLight riconosce le notti dalla data di ripresa scritta nell’intestazione dei file (una notte va da mezzogiorno a mezzogiorno; senza data si usa la cartella di provenienza). La qualità di ogni frame si valuta rispetto ai frame della stessa notte, così una notte velata non viene scartata in blocco. Dopo l’allineamento ogni notte riceve un peso, calcolato dal rumore del fondo e dalla nitidezza delle stelle e spiegato a parole, e i suoi frame vengono normalizzati su quelli della notte di riferimento. Nel pannello Impila, quando le notti sono più di una, ogni notte si può escludere o pesare a mano. Il metodo Mediana non usa i pesi; la normalizzazione vale per tutti i metodi.',
    see: ['Impilamento', 'Qualità del frame', 'Rumore', 'Fondo cielo', 'Libreria di calibrazione']
  },
  {
    term: 'Fusione HDR di pose diverse',
    alternatives: ['HDR', 'pose brevi', 'pose lunghe', 'nucleo saturo', 'esposizioni multiple'],
    category: 'stacking',
    definition:
      'Combinazione di due o più serie di frame riprese con tempi di posa diversi. Le pose lunghe raccolgono le parti deboli dell’oggetto ma saturano le zone più luminose, dove il dato registrato è perso; le pose brevi registrano quelle zone senza saturarle. Ogni serie si impila separatamente; le serie brevi, riportate alla scala della lunga, sostituiscono quest’ultima solo dove si avvicina alla saturazione, con un passaggio graduale.',
    inStarLight:
      'Quando i frame di luce hanno pose diverse fra loro di almeno una volta e mezza, con almeno due frame per serie, il pannello Impila mostra la scheda Fusione HDR, attiva in modo predefinito. Il rapporto di luminosità fra le serie e il livello del fondo di ciascuna si misurano sui pixel ben esposti in entrambe, non si ricavano dai tempi dichiarati: valgono così anche guadagni diversi e un cielo cambiato fra una serie e l’altra. Il risultato resta lineare e viene riportato fra 0 e 1. Con l’impilamento sulla cometa la fusione non è disponibile.',
    see: ['Impilamento', 'Saturazione', 'Gamma dinamica', 'HDR, recupero delle zone luminose']
  },
  {
    term: 'Allineamento',
    alternatives: ['registrazione', 'registration', 'alignment', 'allinea sulle stelle'],
    category: 'stacking',
    definition:
      'Calcolo della trasformazione geometrica che sovrappone ogni frame a un frame di riferimento, compensando gli spostamenti, le rotazioni e piccole variazioni di scala avvenuti durante la ripresa. Senza allineamento la somma produrrebbe stelle mosse.',
    inStarLight:
      'Con l’opzione Allinea sulle stelle, StarLight individua le stelle di ogni frame e le confronta con quelle del frame migliore per mezzo di triangoli, la cui forma non cambia con lo spostamento o la rotazione. La trasformazione comprende traslazione, rotazione e scala. Il passo Impila riporta per ogni frame lo spostamento misurato.',
    see: ['Frame di riferimento', 'Impilamento', 'Rotazione di campo']
  },
  {
    term: 'Frame di riferimento',
    alternatives: ['riferimento', 'reference frame', 'frame migliore'],
    category: 'stacking',
    definition:
      'Frame su cui vengono allineati tutti gli altri. La sua geometria diventa quella dell’immagine impilata; conviene quindi che sia nitido e ricco di stelle.',
    inStarLight:
      'StarLight usa come riferimento il frame con il punteggio di qualità più alto della sessione.',
    see: ['Allineamento', 'Qualità del frame']
  },
  {
    term: 'Qualità del frame',
    alternatives: ['punteggio', 'qualità minima', 'scarto dei frame', 'frame scartati', 'valutazione dei frame'],
    category: 'stacking',
    definition:
      'Valutazione di un frame in base al numero di stelle visibili e alla loro nitidezza. Le nuvole e la foschia riducono le stelle rilevate; il mosso, la cattiva messa a fuoco e il seeing le allargano. Escludere i frame peggiori migliora il risultato più di quanto lo peggiori la perdita di segnale.',
    inStarLight:
      'Ogni frame riceve un punteggio in percentuale rispetto ai migliori della stessa sessione, calcolato come prodotto di due rapporti: le stelle rilevate rispetto a quelle dei frame migliori e l’HFR dei frame migliori rispetto al suo. I frame sotto il valore del cursore Qualità minima vengono esclusi. Nella sessione dal vivo i punteggi vengono ricalcolati man mano che arrivano frame migliori.',
    see: ['HFR', 'Seeing', 'Impilamento', 'Sessione dal vivo']
  },
  {
    term: 'HFR',
    alternatives: ['Half Flux Radius', 'raggio a metà flusso'],
    category: 'stacking',
    definition:
      'Sigla di Half Flux Radius: raggio, in pixel, del cerchio che contiene metà della luce di una stella. Misura la nitidezza delle stelle in modo poco sensibile al rumore: un valore più basso indica stelle più piccole e un’immagine più nitida.',
    inStarLight:
      'L’HFR mediano di ogni frame compare nel dettaglio dei frame del passo Impila e concorre al punteggio di qualità. Il comando Mostra le stelle rilevate del menu Visualizza segna ogni stella con un cerchio proporzionale al suo HFR. La deconvoluzione ricava dall’HFR l’ampiezza della sfocatura quando il cursore relativo è a zero.',
    see: ['FWHM', 'Qualità del frame', 'PSF', 'Deconvoluzione']
  },
  {
    term: 'FWHM',
    alternatives: ['Full Width at Half Maximum', 'larghezza a metà altezza'],
    category: 'stacking',
    definition:
      'Sigla di Full Width at Half Maximum: diametro del profilo di una stella misurato a metà della sua intensità massima. È la misura più diffusa del seeing e della nitidezza, espressa in pixel o in secondi d’arco; per un profilo gaussiano vale circa il doppio dell’HFR.',
    inStarLight:
      'StarLight mostra la nitidezza dei frame con l’HFR. Una stima della larghezza delle stelle viene usata internamente, per esempio dalla rimozione delle scie, che considera scia solo una riga larga quanto una stella e molto più lunga.',
    see: ['HFR', 'Seeing', 'PSF']
  },
  {
    term: 'Media',
    alternatives: ['media aritmetica', 'average', 'mean'],
    category: 'stacking',
    definition:
      'Somma dei valori divisa per il loro numero. Come metodo di impilamento usa tutto il segnale e dà il rumore più basso, ma un disturbo presente in un solo frame, come la scia di un satellite, si trasferisce attenuato nel risultato.',
    inStarLight:
      'Il metodo Media del passo Impila combina tutti i valori di ciascun pixel. È consigliato solo quando nessun frame presenta disturbi.',
    see: ['Mediana', 'Scarto delle code', 'Impilamento']
  },
  {
    term: 'Mediana',
    alternatives: ['median', 'valore centrale'],
    category: 'stacking',
    definition:
      'Valore centrale di un insieme di misure ordinate dalla più bassa alla più alta. A differenza della media non risente dei valori isolati molto diversi dagli altri, come la traccia di un satellite presente in un solo scatto, ma usa una parte minore dell’informazione e lascia un rumore un po’ più alto.',
    inStarLight:
      'La mediana è usata per comporre i master di calibrazione, per sostituire i pixel difettosi, come metodo di impilamento Mediana e come centro di riferimento del metodo Robusto. Nel passo Importa la mediana dei pixel indica il livello del fondo cielo.',
    see: ['Media', 'Scarto delle code', 'Master', 'MAD']
  },
  {
    term: 'Deviazione standard',
    alternatives: ['sigma', 'σ', 'deviazione tipica', 'scarto quadratico medio'],
    category: 'stacking',
    definition:
      'Misura della dispersione di un insieme di valori attorno alla loro media: indica l’ampiezza tipica delle variazioni. Applicata ai pixel del fondo cielo esprime il livello del rumore.',
    inStarLight:
      'La soglia di scarto del metodo Robusto è espressa in deviazioni standard. StarLight stima la dispersione con metodi robusti, che non vengono falsati dalle stelle luminose.',
    see: ['MAD', 'Scarto delle code', 'Soglia di scarto']
  },
  {
    term: 'MAD',
    alternatives: ['deviazione assoluta mediana', 'median absolute deviation', 'statistiche robuste'],
    category: 'stacking',
    definition:
      'Sigla di Median Absolute Deviation: mediana delle distanze dei valori dalla loro mediana. È una misura di dispersione robusta, poco influenzata dai valori estremi; moltiplicata per 1,4826 diventa confrontabile con la deviazione standard.',
    inStarLight:
      'Mediana e MAD sono le statistiche con cui StarLight misura il fondo cielo e il rumore delle immagini, perché le stelle luminose non le falsano.',
    see: ['Mediana', 'Deviazione standard', 'Rumore']
  },
  {
    term: 'Scarto delle code',
    alternatives: ['sigma clipping', 'kappa-sigma', 'rigetto', 'rejection', 'Robusto', 'metodo Robusto', 'scarto dei valori anomali'],
    category: 'stacking',
    definition:
      'Metodo di impilamento che, per ogni pixel, esclude i valori troppo lontani dal valore centrale prima di calcolare la media. Elimina le tracce dei satelliti e degli aerei, i raggi cosmici e altri disturbi presenti in pochi frame, conservando quasi tutto il segnale.',
    inStarLight:
      'È il metodo Robusto del passo Impila, quello predefinito. Per ogni pixel StarLight calcola la mediana dei valori dei frame e la loro dispersione, scarta i valori che se ne discostano più della soglia di scarto (3 deviazioni standard in partenza) e fa la media dei rimanenti. Al termine il passo Impila riporta il numero di valori scartati.',
    see: ['Soglia di scarto', 'Mediana', 'Raggi cosmici', 'Scie di satelliti']
  },
  {
    term: 'Soglia di scarto',
    alternatives: ['soglia di rigetto', 'kappa', 'clipping threshold'],
    category: 'stacking',
    definition:
      'Distanza massima dal valore centrale, espressa in deviazioni standard, oltre la quale un valore viene escluso dallo scarto delle code. Una soglia bassa elimina più disturbi ma scarta anche parte del segnale e del rumore normale; una soglia alta conserva più segnale ma lascia passare i disturbi deboli.',
    inStarLight:
      'Si regola con il cursore Soglia di scarto della scheda Combinazione del passo Impila. La stessa soglia è usata dal drizzle per scartare i disturbi.',
    see: ['Scarto delle code', 'Deviazione standard']
  },
  {
    term: 'Raggi cosmici',
    alternatives: ['cosmic rays', 'cosmici'],
    category: 'stacking',
    definition:
      'Particelle di alta energia che colpiscono il sensore e lasciano punti o brevi tratti luminosi in un singolo frame. Compaiono in posizioni casuali, quindi non si correggono con il dark ma con metodi di combinazione che scartano i valori anomali.',
    inStarLight:
      'Vengono eliminati dal metodo Robusto e dal metodo Mediana durante l’impilamento e, nei master di calibrazione, dalla combinazione con la mediana.',
    see: ['Scarto delle code', 'Mediana']
  },
  {
    term: 'Drizzle',
    alternatives: ['drizzling', 'drizzle 2×', 'variable-pixel linear reconstruction', 'super-risoluzione'],
    category: 'stacking',
    definition:
      'Metodo di impilamento che proietta ogni pixel dei frame, ridotto a una «goccia» più piccola del pixel stesso, su una griglia di uscita più fitta. Sfrutta gli spostamenti di frazioni di pixel fra un frame e l’altro per recuperare dettaglio che il campionamento del sensore aveva reso più grossolano. Richiede molti frame e un leggero spostamento fra le pose.',
    inStarLight:
      'Nel passo Impila il drizzle a 2× raddoppia larghezza e altezza del risultato; richiede l’allineamento attivo e rende di più con almeno una ventina di frame. Il risultato ha quattro volte i pixel e richiede più memoria e più tempo: se la memoria non basta, l’impilamento procede senza drizzle e compare un avviso. I pixel della griglia fine non raggiunti da nessuna goccia vengono riempiti con l’impilamento normale.',
    see: ['Dimensione della goccia', 'Bayer drizzle', 'Allineamento']
  },
  {
    term: 'Dimensione della goccia',
    alternatives: ['pixfrac', 'drop shrink', 'goccia'],
    category: 'stacking',
    definition:
      'Frazione della dimensione del pixel originale usata come goccia nel drizzle. Una goccia piccola produce stelle più nitide ma, con pochi frame, lascia rumore e piccoli vuoti; una goccia pari a 1 dà un risultato più morbido e uniforme.',
    inStarLight:
      'Si regola con il cursore Dimensione della goccia nella scheda Drizzle del passo Impila. Un valore fra 0,7 e 0,8 è un buon compromesso.',
    see: ['Drizzle', 'Bayer drizzle']
  },
  {
    term: 'Bayer drizzle',
    alternatives: ['CFA drizzle', 'drizzle Bayer', 'drizzle dai dati grezzi'],
    category: 'stacking',
    definition:
      'Variante del drizzle per i sensori a colori: invece di ricostruire il colore di ogni frame per interpolazione, deposita sulla griglia di uscita solo i valori effettivamente misurati da ciascun pixel nel suo colore. Gli spostamenti fra i frame riempiono i colori mancanti. Produce stelle più nitide e colori più puliti, a fronte di un rumore fine leggermente più alto.',
    inStarLight:
      'L’opzione Bayer drizzle del passo Impila è disponibile con i frame grezzi di un sensore a colori, con lo schema di Bayer nell’intestazione. Migliora nitidezza e colore già a 1× e a 2× aggiunge risoluzione. Non si applica ai file già impilati o già ricostruiti a colori, che non contengono più il colore misurato pixel per pixel.',
    see: ['Drizzle', 'Matrice di Bayer', 'Ricostruzione del colore']
  },
  {
    term: 'Bordi a bassa copertura',
    alternatives: ['copertura', 'bordi rumorosi', 'ritaglio dei bordi', 'cornice rumorosa'],
    category: 'stacking',
    definition:
      'Zone ai margini di un’immagine impilata in cui si sovrappongono pochi frame, perché il campo si è spostato o ruotato durante la ripresa. Contengono più rumore e spesso una dominante di colore, e formano una cornice di qualità inferiore al resto dell’immagine.',
    inStarLight:
      'Con l’opzione Ritaglia i bordi coperti da pochi frame del passo Impila, dopo l’impilamento viene proposto il ritaglio che conserva solo la parte coperta da almeno il 70% dei frame. Il ritaglio si modifica o si elimina nel passo Esporta e i dati dell’immagine restano interi.',
    see: ['Ritaglio', 'Rotazione di campo', 'Allineamento']
  },
  {
    term: 'Immagine già impilata',
    alternatives: ['Stacked', 'stack del telescopio', 'STACKCNT', 'NCOMBINE', 'file impilato'],
    category: 'stacking',
    definition:
      'File che contiene già la combinazione di più frame, prodotta dal telescopio o da un programma di ripresa. Ha un rapporto segnale/rumore migliore di un singolo frame ma non conserva i dati grezzi originali.',
    inStarLight:
      'StarLight riconosce i file già impilati dal numero di frame dichiarato nell’intestazione e ne mostra il numero di frame integrati e l’integrazione totale. Questi file si elaborano direttamente dal passo Elabora in poi e possono essere uniti in un mosaico; non sono adatti al Bayer drizzle.',
    see: ['Integrazione totale', 'Mosaico', 'Bayer drizzle']
  },
  {
    term: 'Sessione dal vivo',
    alternatives: ['live stacking', 'impilamento dal vivo', 'cartella sorvegliata', 'live'],
    category: 'stacking',
    definition:
      'Modalità di lavoro in cui ogni nuovo frame viene allineato e aggiunto all’immagine impilata durante la ripresa stessa, così il risultato migliora man mano che la sessione prosegue.',
    inStarLight:
      'La sessione dal vivo del passo Impila sorveglia la cartella in cui il programma di ripresa salva i frame, anche se è una cartella di rete. Accetta file FITS (anche compressi), XISF e RAW; attende che ogni file sia completo, lo analizza, lo allinea e ricalcola l’impilamento. L’opzione Includi i frame già presenti aggiunge anche i frame salvati prima dell’avvio. La cartella proposta si imposta nelle Impostazioni, alla scheda Telescopio.',
    see: ['Impilamento', 'Qualità del frame', 'Bordi a bassa copertura']
  },
  {
    term: 'Mosaico',
    alternatives: ['mosaic', 'pannelli', 'pannello'],
    category: 'stacking',
    definition:
      'Immagine composta da più inquadrature di zone adiacenti del cielo, dette pannelli, unite in un campo più ampio di quello dello strumento. I pannelli devono sovrapporsi in parte, perché le zone comuni servono ad accordarne posizione, fondo e luminosità.',
    inStarLight:
      'Il mosaico del passo Impila colloca ogni pannello con la propria soluzione astrometrica, letta dal file oppure calcolata con il comando Risolvi il campo. Il fondo cielo e la luminosità vengono pareggiati nelle zone in comune, canale per canale e ignorando le stelle, e i bordi vengono fusi senza linee di giunzione. La risoluzione è quella del pannello più dettagliato. La sovrapposizione consigliata è del 10-20%.',
    see: ['Soluzione astrometrica', 'Risoluzione del campo', 'Fondo cielo']
  },
  {
    term: 'Allineamento sul nucleo',
    alternatives: ['cometa', 'cometa ferma', 'comet stacking', 'impilamento della cometa'],
    category: 'stacking',
    definition:
      'Tecnica di impilamento per le comete, che si spostano rispetto alle stelle durante la ripresa. Allineando i frame sulle stelle la cometa risulta allungata; allineandoli sul nucleo della cometa questa risulta nitida e le stelle diventano strisce.',
    inStarLight:
      'La scheda Cometa del passo Impila offre tre scelte: Stelle ferme (impilamento normale), Cometa ferma (allineamento sul nucleo) e Tutte e due, che ricava la sola cometa dalla somma allineata sul nucleo, la toglie dai frame, somma i frame sulle stelle e infine la ricompone sopra. Il nucleo si cerca in automatico come punto luminoso esteso che si sposta a velocità costante, usando l’ora di scatto dei file, oppure si indica con un clic sul primo e sull’ultimo frame. Il drizzle si applica solo con Cometa ferma.',
    see: ['Nucleo, chioma e coda', 'Allineamento', 'Scarto delle code']
  },
  {
    term: 'Nucleo, chioma e coda',
    alternatives: ['nucleo', 'chioma', 'coda', 'coma della cometa'],
    category: 'stacking',
    definition:
      'Le parti di una cometa. Il nucleo è il corpo solido, che nelle immagini corrisponde al punto più luminoso; la chioma è la nube diffusa di gas e polveri che lo circonda; la coda è la scia di gas e polveri spinta in direzione opposta al Sole.',
    inStarLight:
      'L’allineamento sul nucleo usa il nucleo come riferimento; la sua posizione, misurata o ricavata dal moto regolare, viene riportata per ogni frame nella scheda Cometa.',
    see: ['Allineamento sul nucleo']
  },

  // ---------------------------------------------------------------- Processing
  {
    term: 'Dati lineari',
    alternatives: ['frame lineare', 'immagine lineare', 'lineare', 'linear'],
    category: 'processing',
    definition:
      'Immagine in cui ogni valore è proporzionale alla luce raccolta dal pixel, come esce dal sensore e dall’impilamento. Il segnale del cielo profondo occupa una frazione minima della scala, quindi sullo schermo l’immagine appare quasi nera. Molte operazioni, come la calibrazione, l’estrazione del fondo, il bilanciamento del colore e la deconvoluzione, sono corrette solo su dati lineari.',
    inStarLight:
      'Il passo Elabora raccoglie gli strumenti che lavorano sui dati ancora lineari; la distensione, nel passo Correggi, viene applicata dopo. Il visore mostra comunque l’immagine distesa, perché sia leggibile.',
    see: ['Distensione', 'Istogramma']
  },
  {
    term: 'Distensione',
    alternatives: ['stretch', 'stretching', 'stiramento', 'distensione dell’istogramma', 'trasformazione non lineare'],
    category: 'processing',
    definition:
      'Trasformazione non lineare che schiarisce i toni deboli di un’immagine lineare e comprime quelli luminosi, rendendo visibili nebulose e galassie senza portare al bianco le stelle. Dopo la distensione i dati non sono più proporzionali alla luce raccolta.',
    inStarLight:
      'La scheda Distensione del passo Correggi offre due curve: Mezzitoni, con punto di nero, mezzitoni e punto di bianco, e la distensione iperbolica generalizzata (GHS). Il pulsante Auto calcola punto di nero e mezzitoni dal fondo cielo con tre livelli di intensità: Delicata, Equilibrata e Spinta. L’opzione Conserva il colore applica la distensione alla luminosità senza alterare il rapporto fra i canali.',
    see: ['Punto di nero', 'Mezzitoni', 'Punto di bianco', 'GHS', 'Dati lineari']
  },
  {
    term: 'Punto di nero',
    alternatives: ['black point', 'livello del nero', 'ombre', 'shadows'],
    category: 'processing',
    definition:
      'Livello sotto il quale tutti i valori diventano nero pieno. Alzandolo si scurisce il fondo cielo e si nasconde il rumore di fondo, ma si perde anche il segnale più debole.',
    inStarLight:
      'Si regola con il cursore Punto di nero della scheda Distensione nel passo Correggi; il pulsante Auto lo colloca poco sotto il fondo cielo misurato.',
    see: ['Distensione', 'Punto di bianco', 'Istogramma']
  },
  {
    term: 'Punto di bianco',
    alternatives: ['white point', 'livello del bianco', 'luci', 'highlights'],
    category: 'processing',
    definition:
      'Livello sopra il quale tutti i valori diventano bianco pieno. Abbassandolo si aumenta il contrasto, ma le stelle e le zone più luminose perdono dettaglio.',
    inStarLight:
      'Si regola con il cursore Punto di bianco della scheda Distensione nel passo Correggi. Abracadabra lo mantiene al massimo della scala, in modo che il bianco resti riservato alle stelle luminose.',
    see: ['Distensione', 'Punto di nero', 'Pixel saturi']
  },
  {
    term: 'Mezzitoni',
    alternatives: ['MTF', 'funzione di trasferimento dei mezzitoni', 'midtones', 'midtone transfer function', 'toni medi'],
    category: 'processing',
    definition:
      'Parametro della distensione che stabilisce dove cade la luminosità media dell’immagine. La curva usata, detta funzione di trasferimento dei mezzitoni (MTF), lascia invariata l’immagine con il valore 0,5 e schiarisce sempre di più i toni deboli man mano che il valore scende.',
    inStarLight:
      'È il cursore Mezzitoni della scheda Distensione nel passo Correggi: i valori bassi fanno emergere le nebulose deboli. Il pulsante Auto lo calcola dal fondo cielo.',
    see: ['Distensione', 'Punto di nero', 'GHS']
  },
  {
    term: 'GHS',
    alternatives: ['distensione iperbolica generalizzata', 'Generalized Hyperbolic Stretch', 'iperbolica', 'punto di simmetria'],
    category: 'processing',
    definition:
      'Sigla di Generalized Hyperbolic Stretch, distensione iperbolica generalizzata. È una famiglia di curve di distensione che concentra l’aumento di contrasto attorno a un livello di luminosità scelto, detto punto di simmetria, e protegge a richiesta le ombre e le luci. Consente, per esempio, di far emergere i bracci deboli di una galassia senza portare al bianco il nucleo.',
    inStarLight:
      'Si sceglie con la voce Iperbolica (GHS) della scheda Distensione nel passo Correggi, con i cursori Forza, Intensità locale, Punto di simmetria, Protezione delle ombre e Protezione delle luci. Abracadabra usa la GHS per la distensione automatica.',
    see: ['Distensione', 'Mezzitoni', 'Abracadabra']
  },
  {
    term: 'Istogramma',
    alternatives: ['histogram', 'livelli'],
    category: 'processing',
    definition:
      'Grafico che indica quanti pixel hanno ciascun valore di luminosità, dal nero a sinistra al bianco a destra. In un’immagine astronomica lineare quasi tutti i pixel sono addensati all’estrema sinistra; dopo una buona distensione il picco del fondo cielo si sposta verso il primo quarto della scala.',
    inStarLight:
      'Il visore mostra un istogramma compatto dell’immagine così come appare, dopo tutte le regolazioni e il filtro fotografico. L’editor delle curve mostra sullo sfondo l’istogramma dei livelli che la curva riceve. Serve a verificare che non si stia tagliando il segnale debole o portando al bianco le stelle.',
    see: ['Distensione', 'Curve', 'Punto di nero']
  },
  {
    term: 'Curve',
    alternatives: ['curva di tono', 'curve RGB', 'curves', 'curva a S'],
    category: 'processing',
    definition:
      'Grafico che associa a ogni livello di luminosità in ingresso un livello in uscita. La diagonale lascia l’immagine invariata; una curva più alta schiarisce, una più bassa scurisce; una curva a forma di S aumenta il contrasto scurendo le ombre e schiarendo le luci. Applicata a un solo canale corregge le dominanti di colore.',
    inStarLight:
      'La scheda Curve del passo Correggi agisce sulla luce o sui singoli canali R, G e B. Un clic aggiunge un punto, il trascinamento lo sposta e il tasto destro lo rimuove. Con l’opzione Conserva il colore attiva le curve dei singoli canali non hanno effetto.',
    see: ['Istogramma', 'Gamma', 'Dominante di colore']
  },
  {
    term: 'Gamma',
    alternatives: ['correzione gamma', 'gamma correction'],
    category: 'processing',
    definition:
      'Parametro di una curva di potenza che schiarisce o scurisce i toni medi lasciando invariati il nero e il bianco.',
    inStarLight:
      'Si regola con il cursore Gamma della scheda Toni nel passo Correggi; sotto 1 scurisce i mezzitoni, sopra 1 li schiarisce.',
    see: ['Curve', 'Mezzitoni']
  },
  {
    term: 'Fondo cielo',
    alternatives: ['sky background', 'fondo', 'background', 'livello del cielo'],
    category: 'processing',
    definition:
      'Luce diffusa presente in tutta l’immagine, indipendente dagli oggetti ripresi, dovuta all’inquinamento luminoso, alla Luna, al bagliore naturale dell’atmosfera e alla luce zodiacale. Spesso varia da un lato all’altro del campo e aggiunge una dominante di colore.',
    inStarLight:
      'Il passo Importa indica il livello del fondo con la mediana dei pixel. Le variazioni del fondo si correggono con l’estrazione del fondo cielo del passo Elabora; il livello medio e il suo colore con la rimozione del fondo del passo Filtri. Il pulsante Auto della distensione si basa sul fondo misurato.',
    see: ['Gradiente', 'Estrazione del fondo cielo', 'Rimozione del fondo', 'Inquinamento luminoso']
  },
  {
    term: 'Gradiente',
    alternatives: ['gradient', 'gradiente di luminosità', 'alone', 'variazione del fondo'],
    category: 'processing',
    definition:
      'Variazione graduale della luminosità del fondo cielo da una zona all’altra dell’immagine, tipicamente più chiaro dal lato rivolto verso una città o verso la Luna. Rende difficile distendere l’immagine in modo uniforme.',
    inStarLight:
      'I gradienti si correggono con l’estrazione del fondo cielo della scheda Difetti e fondo cielo, nel passo Elabora. Una regolazione locale con maschera Sfumatura può compensare un lato rimasto più chiaro.',
    see: ['Fondo cielo', 'Estrazione del fondo cielo', 'Regolazioni locali']
  },
  {
    term: 'Estrazione del fondo cielo',
    alternatives: ['rimozione del gradiente', 'background extraction', 'modello del fondo', 'funzioni a base radiale', 'RBF', 'sottrazione del fondo'],
    category: 'processing',
    definition:
      'Procedimento che stima la forma del fondo cielo a partire da campioni prelevati nelle zone prive di oggetti e la sottrae dall’immagine, rendendo il fondo uniforme e di colore neutro. Va eseguito sui dati lineari, prima della distensione.',
    inStarLight:
      'Nella scheda Difetti e fondo cielo del passo Elabora il modo Semplice descrive il fondo con una superficie morbida, adatta ai gradienti regolari; il modo Avanzato usa funzioni a base radiale, che seguono anche aloni e variazioni irregolari, con i cursori Campioni per lato, Levigatezza e Tolleranza. I campioni troppo diversi dal modello vengono considerati parte dell’oggetto e scartati.',
    see: ['Fondo cielo', 'Gradiente', 'Rimozione del fondo', 'Dati lineari']
  },
  {
    term: 'Riduzione del rumore',
    alternatives: ['denoise', 'denoising', 'noise reduction', 'antirumore'],
    category: 'processing',
    definition:
      'Insieme di tecniche che attenuano la grana dell’immagine cercando di conservare i dettagli e i bordi. Un’azione eccessiva produce un aspetto artificiale, cancella le stelle deboli e le strutture fini.',
    inStarLight:
      'Nel passo Elabora sono disponibili NL-Bayes e le ondine, per scala; il cursore Grana colorata agisce sul solo rumore di colore. Il passo Filtri contiene una riduzione del rumore che calcola la media dei pixel vicini solo dove hanno luminosità simile; con l’intensità alta la zona considerata si allarga e scioglie anche la grana a grumi. Le regolazioni locali applicano la riduzione del rumore a una sola zona.',
    see: ['NL-Bayes', 'Ondine', 'Rumore di colore', 'Rumore']
  },
  {
    term: 'NL-Bayes',
    alternatives: ['Non-Local Bayes', 'non locale'],
    category: 'processing',
    definition:
      'Metodo di riduzione del rumore che, per ogni piccola zona dell’immagine, cerca le zone simili in un’area circostante e ne stima statisticamente il contenuto privo di rumore. Conserva bordi e dettagli meglio di una semplice sfocatura.',
    inStarLight:
      'È il cursore NL-Bayes della scheda Riduzione del rumore nel passo Elabora. Lascia in parte la grana a grumi di qualche pixel, che si tratta con le ondine.',
    see: ['Riduzione del rumore', 'Ondine']
  },
  {
    term: 'Ondine',
    alternatives: ['wavelet', 'trasformata a ondine', 'scomposizione multiscala', 'scale'],
    category: 'processing',
    definition:
      'Termine italiano per wavelet. Indica il metodo che scompone l’immagine in strati di dimensione diversa, dai dettagli di un pixel alle strutture di decine di pixel, per agire su ciascuno separatamente: si può ridurre il rumore a una certa scala o rinforzare i dettagli a un’altra.',
    inStarLight:
      'StarLight scompone l’immagine in cinque scale, da 1 a 16 pixel. Nella scheda Riduzione del rumore un cursore per scala attenua la grana di quella dimensione; nella scheda Dettagli per scala un cursore per scala rinforza o attenua i dettagli corrispondenti.',
    see: ['Dettagli per scala', 'NL-Bayes', 'Riduzione del rumore']
  },
  {
    term: 'Dettagli per scala',
    alternatives: ['nitidezza multiscala', 'rinforzo per scala', 'multiscala'],
    category: 'processing',
    definition:
      'Regolazione che rinforza o attenua i dettagli di una determinata dimensione. Le scale piccole corrispondono alla grana e ai filamenti sottili, quelle grandi ai bracci delle galassie e alle nubi.',
    inStarLight:
      'La scheda Dettagli per scala del passo Elabora ha cinque cursori, da 1 a 16 pixel, e usa la stessa scomposizione delle ondine.',
    see: ['Ondine', 'Nitidezza']
  },
  {
    term: 'Nitidezza',
    alternatives: ['sharpening', 'maschera di contrasto', 'unsharp mask'],
    category: 'processing',
    definition:
      'Accentuazione dei dettagli fini, ottenuta di solito sottraendo all’immagine una sua versione sfocata. Un uso eccessivo produce aloni scuri attorno alle stelle e amplifica il rumore.',
    inStarLight:
      'Il passo Filtri contiene un cursore Nitidezza basato su questo principio. Le regolazioni locali applicano la nitidezza a una sola zona. Per recuperare la nitidezza persa per turbolenza e ottica è più indicata la deconvoluzione.',
    see: ['Deconvoluzione', 'Dettagli per scala', 'Contrasto locale']
  },
  {
    term: 'PSF',
    alternatives: ['Point Spread Function', 'funzione di diffusione del punto', 'profilo stellare'],
    category: 'processing',
    definition:
      'Sigla di Point Spread Function, funzione di diffusione del punto. Descrive la forma con cui una sorgente puntiforme, come una stella, appare nell’immagine dopo il passaggio nell’atmosfera e nell’ottica. Si misura sulle stelle e ne riassume la nitidezza.',
    inStarLight:
      'La deconvoluzione usa una PSF stimata dalla forma delle stelle dell’immagine, a partire dal loro HFR, quando l’ampiezza della sfocatura non è impostata a mano.',
    see: ['Deconvoluzione', 'HFR', 'FWHM']
  },
  {
    term: 'Deconvoluzione',
    alternatives: ['Richardson-Lucy', 'deconvolution', 'deblur'],
    category: 'processing',
    definition:
      'Calcolo che inverte in parte la sfocatura prodotta dall’atmosfera e dall’ottica, a partire dalla PSF. Non aggiunge dettagli, ma ripristina quelli attenuati. Un uso eccessivo produce aloni scuri attorno alle stelle e grana.',
    inStarLight:
      'La scheda Deconvoluzione del passo Elabora usa il metodo di Richardson-Lucy. Il cursore Iterazioni stabilisce quante volte il calcolo viene ripetuto; con Ampiezza della sfocatura a zero l’ampiezza viene misurata sulle stelle; la Regolarizzazione limita l’amplificazione del rumore.',
    see: ['PSF', 'Nitidezza', 'Seeing']
  },
  {
    term: 'Contrasto locale',
    alternatives: ['CLAHE', 'equalizzazione adattiva', 'local contrast'],
    category: 'processing',
    definition:
      'Aumento del contrasto calcolato zona per zona invece che sull’intera immagine, che fa risaltare le strutture interne di galassie e nebulose. Il metodo CLAHE (equalizzazione adattiva dell’istogramma a contrasto limitato) divide l’immagine in zone e limita il contrasto massimo di ciascuna per non amplificare troppo il rumore.',
    inStarLight:
      'La scheda Contrasto locale del passo Elabora ha i cursori Forza, Limite e Zone per lato; un numero maggiore di zone segue strutture più piccole. Il plugin HDR offre un rinforzo del contrasto locale limitato alle zone luminose.',
    see: ['Istogramma', 'HDR, recupero delle zone luminose', 'Nitidezza']
  },
  {
    term: 'Riduzione delle stelle',
    alternatives: ['star reduction', 'stelle più piccole', 'rimpicciolimento delle stelle'],
    category: 'processing',
    definition:
      'Elaborazione che rimpicciolisce le stelle e ne attenua la luce, per restituire risalto a nebulose e galassie nei campi molto ricchi di stelle.',
    inStarLight:
      'La scheda Riduzione delle stelle del passo Elabora ha i cursori Dimensione e Luminosità. Il metodo deforma l’immagine attorno a ogni stella, come una lente che rimpicciolisce, e riempie la corona liberata con il fondo circostante conservandone la grana; non usa reti neurali. Il plugin Separazione di stelle e nebulosa offre un’alternativa basata sulla separazione degli strati.',
    see: ['Separazione di stelle e nebulosa', 'Maschera']
  },
  {
    term: 'Scie di satelliti',
    alternatives: ['scie', 'satelliti', 'aerei', 'tracce', 'satellite trails'],
    category: 'processing',
    definition:
      'Righe luminose lasciate nell’immagine da satelliti e aerei che attraversano il campo durante la posa. Le scie dei satelliti sono dritte e possono interrompersi quando il satellite entra nell’ombra della Terra; quelle degli aerei formano spesso file di trattini per le luci lampeggianti.',
    inStarLight:
      'Durante l’impilamento le scie vengono eliminate dallo scarto delle code. Su una singola immagine, l’interruttore Togli le scie del passo Elabora individua le righe dritte, molto lunghe e larghe quanto una stella, anche interrotte, e ne ricostruisce i pixel con il cielo e la grana dei due lati. Con la soluzione astrometrica restano escluse le galassie e le nebulose del catalogo. Il cursore Sensibilità regola il rilevamento delle scie deboli.',
    see: ['Scarto delle code', 'Impilamento']
  },
  {
    term: 'Abracadabra',
    alternatives: ['elaborazione automatica', 'bacchetta magica', 'automatico'],
    category: 'processing',
    definition:
      'Comando di StarLight che prepara l’immagine in modo automatico, misurandola e scegliendo le regolazioni con criteri prudenti. Il risultato è un punto di partenza, non un’elaborazione definitiva.',
    inStarLight:
      'Il pulsante Abracadabra, nella barra superiore, regola gli strumenti del passo Elabora, esegue il calcolo, imposta nel passo Correggi la distensione iperbolica (GHS), la saturazione e la conservazione del colore, e propone il ritaglio dei bordi rumorosi. Un avviso riassume le correzioni eseguite; tutti i valori restano modificabili e il pulsante Ripristina riporta l’immagine all’originale. L’elaborazione in serie può applicare lo stesso procedimento a ogni file.',
    see: ['GHS', 'Elaborazione in serie', 'Cronologia']
  },
  {
    term: 'Regolazioni locali',
    alternatives: ['regolazione locale', 'correzioni locali', 'local adjustments'],
    category: 'processing',
    definition:
      'Correzioni applicate solo a una parte dell’immagine, delimitata da una maschera, invece che all’intera immagine. Consentono, per esempio, di schiarire le zone deboli di una nebulosa senza bruciarne il nucleo.',
    inStarLight:
      'La scheda Regolazioni locali del passo Correggi gestisce fino a quattro regolazioni, ciascuna con la propria maschera e i cursori luminosità, contrasto, saturazione, vividezza, temperatura, tinta, nitidezza e riduzione del rumore. Si applicano dopo tutte le altre correzioni, sono comprese nell’immagine esportata e vengono salvate nel progetto.',
    see: ['Maschera']
  },
  {
    term: 'Maschera',
    alternatives: ['mask', 'maschera di luminosità', 'maschera di colore', 'maschera stellare', 'pennello', 'gomma'],
    category: 'processing',
    definition:
      'Immagine ausiliaria che stabilisce, pixel per pixel, quanto una correzione deve agire: piena dove la maschera è bianca, nulla dove è nera, parziale nelle zone intermedie. Le maschere più comuni selezionano una fascia di luminosità, un colore o le stelle.',
    inStarLight:
      'Le regolazioni locali offrono sei maschere automatiche (Luce, Colore, Stelle, Oggetto, Sfumatura e Cerchio), con sfumatura dei bordi, intensità e comando Inverti la maschera, oltre a pennello e gomma per disegnare la zona a mano. Il comando Mostra la maschera in rosso evidenzia dove la regolazione agisce.',
    see: ['Regolazioni locali']
  },
  {
    term: 'Ritaglio',
    alternatives: ['crop', 'inquadratura', 'ritagliare'],
    category: 'processing',
    definition:
      'Esclusione delle parti periferiche dell’immagine, per eliminare i bordi difettosi o migliorare la composizione.',
    inStarLight:
      'Il riquadro di ritaglio si regola nel passo Esporta oppure direttamente sul visore con il pulsante Ritaglio della barra superiore. Il ritaglio vale per l’esportazione e non modifica i dati dell’immagine; può mantenere la proporzione di un formato pronto. Abracadabra e l’impilamento ne propongono uno che esclude i bordi rumorosi.',
    see: ['Bordi a bassa copertura', 'Abracadabra', 'Raddrizzamento']
  },
  {
    term: 'Raddrizzamento',
    alternatives: ['raddrizza', 'rotazione libera', 'ruota', 'nord in alto', 'orientamento'],
    category: 'processing',
    definition:
      'Rotazione dell’immagine di un angolo qualsiasi, per correggere un’inquadratura storta o per orientarla in un modo convenzionale, per esempio con il nord del cielo in alto. Una rotazione diversa da un multiplo di 90° richiede di ricalcolare ogni pixel per interpolazione e lascia scoperti gli angoli della tela.',
    inStarLight:
      'I pulsanti ⟲ e ⟳ sopra il visore ruotano di 90° senza ricalcolare i pixel. Il pulsante Raddrizza apre un riquadro con l’angolo libero (anteprima immediata, calcolo con Applica), il comando Traccia una linea, che ricava l’angolo da una linea disegnata lungo un elemento orizzontale o verticale, e il comando Nord in alto, disponibile con la soluzione astrometrica. La rotazione si calcola sempre dall’immagine non ruotata, con interpolazione bicubica, quindi ritoccarla non degrada i dati; l’opzione Ritaglia i bordi vuoti imposta il ritaglio sul rettangolo più grande senza angoli scoperti. Marcatori, maschere, ritaglio e soluzione astrometrica seguono la rotazione, che si annulla con Indietro e si salva nel progetto.',
    see: ['Ritaglio', 'Soluzione astrometrica', 'Specchiatura']
  },
  {
    term: 'Specchiatura',
    alternatives: ['specchia', 'specchio', 'ribaltamento', 'ribalta', 'flip', 'immagine speculare', 'ruota e specchia'],
    category: 'processing',
    definition:
      'Ribaltamento dell’immagine da sinistra a destra o dall’alto in basso, senza perdita di qualità. Alcuni sistemi ottici, per esempio quelli con un diagonale a specchio, e alcuni programmi di acquisizione producono immagini speculari rispetto al cielo: la specchiatura le riporta come appaiono in cielo, con l’est a sinistra quando il nord è in alto.',
    inStarLight:
      'I due pulsanti Specchia della barra in alto, accanto a ⟲ e ⟳, ribaltano l’immagine da sinistra a destra o dall’alto in basso spostando i pixel senza ricalcolarli. Lo specchio vale anche per l’esportazione, si annulla con Indietro e viene salvato nel progetto. Marcatori, maschere delle regolazioni locali, ritaglio e soluzione astrometrica lo seguono: nella soluzione lo specchio inverte il verso dell’est rispetto al nord. Specchio e rotazioni si applicano sempre nello stesso ordine, prima lo specchio, poi i quarti di giro, infine l’angolo di Raddrizza, ma i pulsanti agiscono sempre sull’immagine così come appare sullo schermo.',
    see: ['Raddrizzamento', 'Soluzione astrometrica']
  },

  // ---------------------------------------------------------------- Color
  {
    term: 'Canale di colore',
    alternatives: ['canali', 'RGB', 'R', 'G', 'B', 'rosso verde blu'],
    category: 'color',
    definition:
      'Ciascuna delle tre componenti, rossa, verde e blu, di un’immagine a colori. Ogni canale è un’immagine monocromatica che registra la luce in un intervallo di lunghezze d’onda.',
    inStarLight:
      'Molti strumenti agiscono sui canali separatamente: le curve R, G e B, i guadagni dei canali, la rimozione del fondo e il plugin Bianco e nero per canale.',
    see: ['Guadagni dei canali', 'Curve', 'Bianco e nero per canale']
  },
  {
    term: 'Bilanciamento del bianco',
    alternatives: ['white balance', 'bilanciamento sulle stelle', 'bilanciamento del colore'],
    category: 'color',
    definition:
      'Correzione dei rapporti fra i canali di colore in modo che un riferimento considerato neutro appaia bianco o grigio. In astrofotografia il riferimento può essere il colore medio delle stelle oppure il colore misurato di stelle note.',
    inStarLight:
      'Nella scheda Colore del passo Elabora il bilanciamento Sulle stelle rende bianco il colore medio delle stelle del campo; il bilanciamento Fotometrico usa i colori misurati dal catalogo Gaia ed è il metodo più preciso.',
    see: ['Calibrazione fotometrica del colore', 'Dominante di colore', 'Guadagni dei canali']
  },
  {
    term: 'Calibrazione fotometrica del colore',
    alternatives: ['bilanciamento fotometrico', 'fotometrico', 'calibrazione del colore', 'colore da Gaia'],
    category: 'color',
    definition:
      'Bilanciamento del colore basato sui colori reali delle stelle, misurati da un catalogo fotometrico. Si confronta il colore atteso di molte stelle del campo con quello misurato nell’immagine e si ricavano i guadagni dei tre canali che rendono i due insiemi il più possibile coerenti. Il riferimento neutro è una stella simile al Sole (tipo spettrale G2V).',
    inStarLight:
      'Si ottiene con il bilanciamento Fotometrico della scheda Colore e il pulsante Calcola da Gaia. Le stelle del catalogo Gaia vengono proiettate sull’immagine con la soluzione astrometrica e abbinate a quelle rilevate; la luce delle stelle non sature viene misurata con la fotometria d’apertura e i guadagni vengono calcolati con un adattamento robusto e applicati attorno al fondo cielo, che resta neutro. Richiede la connessione a internet e la soluzione astrometrica; non è significativo sulle riprese a banda stretta.',
    see: ['Catalogo Gaia', 'Fotometria', 'Indice di colore', 'Soluzione astrometrica']
  },
  {
    term: 'Fotometria',
    alternatives: ['fotometria d’apertura', 'aperture photometry', 'photometry'],
    category: 'color',
    definition:
      'Misura della quantità di luce ricevuta da una stella o da un oggetto. Nella fotometria d’apertura si somma la luce contenuta in un cerchio attorno alla stella e si sottrae il fondo locale misurato in un anello circostante.',
    inStarLight:
      'La fotometria d’apertura è usata dalla calibrazione fotometrica del colore, separatamente nei tre canali, sulle stelle non sature.',
    see: ['Calibrazione fotometrica del colore', 'Magnitudine']
  },
  {
    term: 'Indice di colore',
    alternatives: ['BP-RP', 'colore di una stella', 'tipo spettrale', 'G2V'],
    category: 'color',
    definition:
      'Differenza fra le magnitudini di una stella misurate in due bande di colore. Indica la temperatura della stella: le stelle calde sono azzurre e hanno un indice basso, quelle fredde sono arancioni e hanno un indice alto. Il catalogo Gaia riporta l’indice BP-RP, fra la banda blu e quella rossa del satellite.',
    inStarLight:
      'La calibrazione fotometrica del colore usa l’indice BP-RP delle stelle Gaia per stabilire quanto ciascuna dovrebbe apparire rossa o azzurra.',
    see: ['Calibrazione fotometrica del colore', 'Catalogo Gaia', 'Magnitudine']
  },
  {
    term: 'Dominante di colore',
    alternatives: ['dominante', 'color cast', 'fondo verdastro', 'fondo rossastro'],
    category: 'color',
    definition:
      'Colorazione uniforme indesiderata che altera tutta l’immagine o il solo fondo cielo, dovuta per esempio all’inquinamento luminoso, alla risposta del sensore o ai filtri antinquinamento.',
    inStarLight:
      'Si corregge con il bilanciamento del bianco del passo Elabora, con la rimozione del fondo del passo Filtri, con i guadagni dei canali e le curve dei singoli canali del passo Correggi. Il plugin Rimozione del verde tratta in modo specifico la dominante verde.',
    see: ['Bilanciamento del bianco', 'Rimozione del fondo', 'Guadagni dei canali', 'Rimozione del verde']
  },
  {
    term: 'Rimozione del fondo',
    alternatives: ['neutralizzazione del fondo', 'neutralizzazione del colore', 'background neutralization', 'fondo neutro'],
    category: 'color',
    definition:
      'Correzione che porta il fondo cielo a un colore neutro sottraendo da ciascun canale il proprio livello di fondo. A differenza dell’estrazione del fondo cielo agisce in modo uniforme su tutta l’immagine e non corregge le variazioni da una zona all’altra.',
    inStarLight:
      'Il cursore Rimozione del fondo del passo Filtri sottrae da ogni canale un livello costante, pari al fondo cielo misurato; il punto di nero viene abbassato della stessa quantità media, quindi la luminosità complessiva resta invariata e cambia solo l’equilibrio fra i colori del fondo.',
    see: ['Fondo cielo', 'Estrazione del fondo cielo', 'Dominante di colore']
  },
  {
    term: 'Guadagni dei canali',
    alternatives: ['guadagno rosso', 'guadagno verde', 'guadagno blu', 'moltiplicatori dei canali'],
    category: 'color',
    definition:
      'Fattori moltiplicativi applicati separatamente ai canali rosso, verde e blu per modificarne l’equilibrio.',
    inStarLight:
      'I cursori Guadagno rosso, Guadagno verde e Guadagno blu della scheda Colore nel passo Correggi correggono le dominanti, per esempio il fondo verdastro lasciato dai filtri antinquinamento luminoso. La calibrazione fotometrica calcola guadagni analoghi in modo automatico.',
    see: ['Dominante di colore', 'Guadagno', 'Calibrazione fotometrica del colore']
  },
  {
    term: 'Rumore di colore',
    alternatives: ['grana colorata', 'rumore cromatico', 'chroma noise', 'macchie di colore'],
    category: 'color',
    definition:
      'Componente del rumore che si manifesta come macchie di colore casuali, soprattutto nel fondo cielo, invece che come variazioni di luminosità.',
    inStarLight:
      'Il cursore Grana colorata della scheda Colore nel passo Elabora elimina le macchie di colore dal fondo e uniforma il colore di ogni stella, senza modificare la nitidezza. Con la banda stretta regola solo quanto il fondo diventa grigio neutro.',
    see: ['Rumore', 'Riduzione del rumore']
  },
  {
    term: 'Saturazione',
    alternatives: ['saturazione dei colori', 'saturation'],
    category: 'color',
    definition:
      'Intensità dei colori, cioè la loro distanza dal grigio di pari luminosità. Aumentarla rende i colori più vivi; ridurla al minimo produce un’immagine in bianco e nero. Il termine non va confuso con i pixel saturi del sensore.',
    inStarLight:
      'Si regola con il cursore Saturazione della scheda Colore nel passo Correggi; a −1 l’immagine diventa in bianco e nero. Abracadabra la dosa in base al rumore di colore misurato. Le regolazioni locali e il plugin Separazione di stelle e nebulosa la regolano su singole parti dell’immagine.',
    see: ['Vividezza', 'Pixel saturi']
  },
  {
    term: 'Vividezza',
    alternatives: ['vibrance', 'vivacità'],
    category: 'color',
    definition:
      'Aumento selettivo della saturazione che agisce soprattutto sui colori poco intensi e lascia quasi invariati quelli già carichi, evitando l’eccesso di colore sulle zone già sature.',
    inStarLight:
      'Si regola con il cursore Vividezza della scheda Colore nel passo Correggi, che dà colore alle nebulose senza impastare le stelle colorate. Il valore si somma alla vividezza propria del filtro fotografico scelto.',
    see: ['Saturazione', 'Filtro fotografico']
  },
  {
    term: 'Conservazione del colore',
    alternatives: ['conserva il colore', 'distensione sulla luminosità', 'color preserving stretch'],
    category: 'color',
    definition:
      'Modo di applicare la distensione alla sola luminosità, mantenendo costante il rapporto fra rosso, verde e blu di ogni pixel. Evita che le stelle e le nebulose luminose perdano colore e tendano al bianco.',
    inStarLight:
      'È l’opzione Conserva il colore della scheda Distensione nel passo Correggi, attivata automaticamente da Abracadabra. Con questa opzione le curve dei singoli canali non hanno effetto.',
    see: ['Distensione', 'Curve', 'Abracadabra']
  },
  {
    term: 'Tavolozza',
    alternatives: ['palette', 'tavolozza di colori', 'mappatura dei colori'],
    category: 'color',
    definition:
      'Nelle riprese a banda stretta, la convenzione con cui le righe di emissione dei diversi gas vengono assegnate ai canali rosso, verde e blu. I colori ottenuti non corrispondono alla visione dell’occhio ma rendono leggibile la distribuzione dei gas.',
    inStarLight:
      'La scheda Banda stretta del passo Elabora propone le tavolozze HOO, Foraxx e Hubble sintetica, con anteprime; la tavolozza Naturale lascia i colori invariati. L’opzione Stelle con il loro colore mantiene alle stelle il colore originale.',
    see: ['HOO', 'Foraxx', 'Tavolozza Hubble', 'Banda stretta']
  },
  {
    term: 'HOO',
    alternatives: ['bicolore', 'Ha-OIII-OIII'],
    category: 'color',
    definition:
      'Tavolozza della banda stretta che assegna l’idrogeno (H) al rosso e l’ossigeno (O) al verde e al blu. Il nome indica il gas di ciascuno dei tre canali. Le zone ricche di idrogeno appaiono rosse, quelle ricche di ossigeno azzurre.',
    inStarLight:
      'È la tavolozza consigliata dalla scheda Banda stretta quando l’intestazione indica un filtro a doppia banda.',
    see: ['Tavolozza', 'H-alfa', 'OIII', 'Filtro a doppia banda']
  },
  {
    term: 'Foraxx',
    alternatives: ['tavolozza Foraxx'],
    category: 'color',
    definition:
      'Tavolozza della banda stretta derivata dalla HOO: dove idrogeno e ossigeno sono entrambi intensi il verde segue l’idrogeno, e fra il rosso e l’azzurro compaiono passaggi dorati.',
    inStarLight:
      'È disponibile nella scheda Banda stretta del passo Elabora.',
    see: ['Tavolozza', 'HOO']
  },
  {
    term: 'Tavolozza Hubble',
    alternatives: ['SHO', 'Hubble sintetica', 'Hubble palette', 'tavolozza SHO'],
    category: 'color',
    definition:
      'Tavolozza resa celebre dalle immagini del telescopio spaziale Hubble, che assegna lo zolfo (S) al rosso, l’idrogeno (H) al verde e l’ossigeno (O) al blu, con il tipico contrasto fra oro e azzurro. Richiede riprese con tre filtri, compreso quello per lo zolfo.',
    inStarLight:
      'La tavolozza Hubble sintetica della scheda Banda stretta ne imita l’aspetto con le sole righe raccolte dal filtro a doppia banda: al posto dello zolfo usa di nuovo l’idrogeno, quindi non mostra dove si trova lo zolfo.',
    see: ['Tavolozza', 'SII', 'HOO']
  },
  {
    term: 'Filtro fotografico',
    alternatives: ['filtri fotografici', 'look', 'preset', 'stile', 'seppia', 'falso colore'],
    category: 'color',
    definition:
      'Trasformazione estetica dei colori e dei toni di un’immagine già elaborata, che non corregge difetti ma ne cambia la resa, dal seppia al falso colore.',
    inStarLight:
      'Il passo Filtri offre ventiquattro filtri fotografici, con il cursore Intensità del filtro. I filtri vengono applicati dopo la distensione, non modificano i dati del file e si possono cambiare o togliere in qualsiasi momento. Alcuni comprendono una propria vividezza e vignettatura.',
    see: ['Vignettatura', 'Vividezza', 'Filtro']
  },

  // ---------------------------------------------------------------- Astrometry and catalogs
  {
    term: 'Soluzione astrometrica',
    alternatives: ['astrometria', 'astrometric solution', 'calibrazione astrometrica'],
    category: 'astrometry',
    definition:
      'Corrispondenza esatta fra i pixel dell’immagine e le coordinate del cielo: per ogni pixel indica ascensione retta e declinazione. Comprende la posizione del centro, la scala, l’orientamento e, a volte, la distorsione dell’ottica. Si scrive nell’intestazione del file secondo lo standard WCS.',
    inStarLight:
      'Con la soluzione astrometrica StarLight segna gli oggetti del catalogo sull’immagine, calcola la calibrazione fotometrica del colore, colloca i pannelli di un mosaico ed esclude le galassie e le nebulose dalla rimozione delle scie. Viene letta dall’intestazione oppure calcolata con il comando Risolvi il campo; le rotazioni e gli specchi fatti con i pulsanti della barra in alto la aggiornano.',
    see: ['WCS', 'Risoluzione del campo', 'Marcatori degli oggetti']
  },
  {
    term: 'WCS',
    alternatives: ['World Coordinate System', 'CRVAL', 'CRPIX', 'CD', 'SIP', 'distorsione SIP'],
    category: 'astrometry',
    definition:
      'Sigla di World Coordinate System: insieme di parole chiave standard (CRVAL, CRPIX, CD e altre) con cui la soluzione astrometrica si scrive nell’intestazione di un file FITS. La convenzione SIP aggiunge i coefficienti che descrivono la distorsione dell’ottica.',
    inStarLight:
      'StarLight legge il WCS dei file che lo contengono e calcola la soluzione, compresa una piccola correzione SIP della distorsione, per quelli che ne sono privi.',
    see: ['Soluzione astrometrica', 'Intestazione', 'FITS']
  },
  {
    term: 'Risoluzione del campo',
    alternatives: ['plate solving', 'plate solve', 'Risolvi il campo', 'solving', 'risoluzione astrometrica'],
    category: 'astrometry',
    definition:
      'Calcolo della soluzione astrometrica dal confronto fra le stelle dell’immagine e quelle di un catalogo. Si cercano configurazioni di stelle con la stessa forma nell’immagine e nel catalogo; quando una corrispondenza fa coincidere molte stelle, la soluzione viene affinata con i minimi quadrati.',
    inStarLight:
      'Il pulsante Risolvi il campo del passo Oggetti confronta i triangoli di stelle dell’immagine con le stelle di un catalogo attorno al punto dichiarato; servono, nell’intestazione del file, le coordinate di puntamento o il nome dell’oggetto. Se è installato e attivo il pacchetto Stelle per la risoluzione del campo, StarLight usa prima quelle stelle, senza internet e in pochi secondi. Se non bastano, di solito perché il campo è stretto e contiene poche stelle fino alla magnitudine 12, passa al catalogo Gaia in rete, solo se l’uso di internet è permesso; la richiesta può durare fino a un minuto. Con internet disattivato un avviso spiega perché le stelle locali non sono bastate e offre il pulsante Riattiva internet, che attiva l’impostazione e riprova. Il messaggio di avanzamento indica la fonte in uso: stelle locali o catalogo Gaia in rete.',
    see: ['Soluzione astrometrica', 'Stelle locali', 'Catalogo Gaia', 'Scala del campo']
  },
  {
    term: 'Catalogo Gaia',
    alternatives: ['Gaia', 'Gaia DR3', 'ESA Gaia'],
    category: 'astrometry',
    definition:
      'Catalogo prodotto dalla missione spaziale Gaia dell’Agenzia spaziale europea, con posizione, luminosità e colore di oltre un miliardo di stelle. È il riferimento più accurato oggi disponibile per l’astrometria e la fotometria delle stelle.',
    inStarLight:
      'StarLight interroga via internet il catalogo Gaia DR3 per la calibrazione fotometrica del colore e per la risoluzione del campo, in quest’ultimo caso quando le stelle locali non sono installate o non bastano, solo se l’uso di internet è permesso nelle Impostazioni (scheda Rete e cataloghi), dove si fissa anche la magnitudine limite delle stelle richieste. Le zone di cielo già scaricate restano in memoria fino alla chiusura del programma.',
    see: ['Risoluzione del campo', 'Calibrazione fotometrica del colore', 'Magnitudine', 'Indice di colore']
  },
  {
    term: 'Stelle locali',
    alternatives: ['UCAC4', 'catalogo UCAC4', 'Stelle per la risoluzione del campo', 'risoluzione del campo senza internet', 'plate solving offline'],
    category: 'astrometry',
    definition:
      'Catalogo di stelle conservato sul computer, usato come riferimento per la risoluzione del campo senza collegarsi a internet. UCAC4 è il quarto catalogo astrometrico dello U.S. Naval Observatory (Zacharias e collaboratori, 2013): posizioni e moti propri di circa 113 milioni di stelle, misurate in una banda fra il verde e il rosso.',
    inStarLight:
      'Il pacchetto Stelle per la risoluzione del campo, nella scheda Cataloghi deep sky della galleria dei plugin, contiene le stelle di UCAC4 fino alla magnitudine 12 con le posizioni aggiornate al 2025 in base al moto proprio, cioè il lento spostamento apparente di ogni stella. Non fa parte dell’installazione: si scarica una volta, si attiva, si disattiva e si disinstalla come gli altri cataloghi. Quando è attivo, Risolvi il campo lo usa per primo; per i campi stretti, dove le stelle fino alla magnitudine 12 sono poche, serve il catalogo Gaia in rete.',
    see: ['Risoluzione del campo', 'Catalogo Gaia', 'Cataloghi deep sky aggiuntivi', 'Magnitudine']
  },
  {
    term: 'Scala del campo',
    alternatives: ['scala dell’immagine', 'pixel scale', 'arcosecondi per pixel', 'risoluzione angolare', '″/px'],
    category: 'astrometry',
    definition:
      'Porzione di cielo coperta da un singolo pixel, in secondi d’arco. Si calcola come 206,265 × dimensione del pixel in micrometri ÷ focale in millimetri: con una focale di 250 mm e pixel di 2,9 µm vale circa 2,4″ per pixel.',
    inStarLight:
      'StarLight la ricava dalla soluzione astrometrica, quando presente, oppure dalla focale e dalla dimensione dei pixel dichiarate nel file; è mostrata nel passo Importa e serve come indizio alla risoluzione del campo.',
    see: ['Focale', 'Pixel', 'Secondo d’arco', 'Campo inquadrato']
  },
  {
    term: 'Campo inquadrato',
    alternatives: ['campo visivo', 'FOV', 'field of view', 'inquadratura'],
    category: 'astrometry',
    definition:
      'Porzione di cielo ripresa nell’immagine, espressa di solito in primi d’arco per lato. Dipende dalla focale e dalle dimensioni del sensore.',
    inStarLight:
      'Il passo Oggetti ne riporta le dimensioni e, alla voce Altri oggetti nel campo, elenca gli oggetti di catalogo le cui coordinate cadono nell’inquadratura.',
    see: ['Scala del campo', 'Primo d’arco', 'Focale']
  },
  {
    term: 'Ascensione retta',
    alternatives: ['AR', 'RA', 'right ascension', 'α'],
    category: 'astrometry',
    definition:
      'Coordinata celeste equivalente alla longitudine, misurata lungo l’equatore celeste verso est a partire dal punto vernale. Si esprime in ore, minuti e secondi (da 0 a 24 ore) oppure in gradi.',
    inStarLight:
      'L’ascensione retta di puntamento è letta dall’intestazione e mostrata nel passo Importa; serve a riconoscere l’oggetto e come punto di partenza della risoluzione del campo.',
    see: ['Declinazione', 'J2000', 'Soluzione astrometrica']
  },
  {
    term: 'Declinazione',
    alternatives: ['Dec', 'DEC', 'declination', 'δ'],
    category: 'astrometry',
    definition:
      'Coordinata celeste equivalente alla latitudine: distanza angolare di un punto dall’equatore celeste, da +90° al polo nord celeste a −90° al polo sud.',
    inStarLight:
      'La declinazione di puntamento è letta dall’intestazione e mostrata nel passo Importa, insieme all’ascensione retta.',
    see: ['Ascensione retta', 'J2000']
  },
  {
    term: 'J2000',
    alternatives: ['epoca J2000', 'equinozio J2000', 'precessione', 'J2000.0'],
    category: 'astrometry',
    definition:
      'Sistema di riferimento delle coordinate celesti fissato al 1° gennaio 2000. Le coordinate cambiano lentamente nel tempo per la precessione dell’asse terrestre, quindi cataloghi e soluzioni astrometriche indicano l’epoca a cui si riferiscono.',
    inStarLight:
      'Il catalogo degli oggetti e la risoluzione del campo usano coordinate J2000; le coordinate di puntamento riferite alla data della ripresa vengono riportate a J2000 prima del confronto.',
    see: ['Ascensione retta', 'Declinazione']
  },
  {
    term: 'Primo d’arco',
    alternatives: ['arcominuto', 'minuto d’arco', 'arcmin', '′'],
    category: 'astrometry',
    definition:
      'Unità di misura angolare pari a un sessantesimo di grado. La Luna piena misura circa trenta primi d’arco.',
    inStarLight:
      'Le dimensioni apparenti degli oggetti e del campo inquadrato, nel passo Oggetti, sono espresse in primi d’arco.',
    see: ['Secondo d’arco', 'Campo inquadrato']
  },
  {
    term: 'Secondo d’arco',
    alternatives: ['arcosecondo', 'arcsec', '″'],
    category: 'astrometry',
    definition:
      'Unità di misura angolare pari a un sessantesimo di primo d’arco, cioè 1/3600 di grado. Si usa per la scala del campo e per la dimensione delle stelle.',
    inStarLight:
      'La scala del campo è espressa in secondi d’arco per pixel.',
    see: ['Primo d’arco', 'Scala del campo']
  },
  {
    term: 'Magnitudine',
    alternatives: ['mag', 'magnitudine apparente', 'magnitudine limite', 'luminosità apparente'],
    category: 'astrometry',
    definition:
      'Misura logaritmica della luminosità apparente di un oggetto: più il numero è basso, più l’oggetto è brillante, e ogni 5 magnitudini la luminosità cambia di un fattore 100. A occhio nudo, sotto un cielo buio, si arriva intorno alla sesta magnitudine. La magnitudine limite è quella degli oggetti più deboli considerati.',
    inStarLight:
      'Il passo Oggetti riporta la magnitudine dell’oggetto principale. Nelle Impostazioni, scheda Rete e cataloghi, la magnitudine limite del catalogo Gaia stabilisce fino a quali stelle deboli si spinge la richiesta per la calibrazione fotometrica.',
    see: ['Catalogo Gaia', 'Fotometria', 'Indice di colore']
  },
  {
    term: 'Costellazione',
    alternatives: ['constellation'],
    category: 'astrometry',
    definition:
      'Ciascuna delle 88 regioni in cui l’Unione Astronomica Internazionale divide la sfera celeste. Indica in quale zona del cielo si trova un oggetto.',
    inStarLight:
      'Il passo Oggetti indica, in italiano, la costellazione dell’oggetto principale.',
    see: ['Oggetto del cielo profondo']
  },
  {
    term: 'Oggetto del cielo profondo',
    alternatives: ['deep sky', 'DSO', 'deep-sky object', 'oggetto deep sky'],
    category: 'astrometry',
    definition:
      'Oggetto astronomico esterno al Sistema solare e diverso dalle singole stelle: galassie, nebulose, ammassi stellari. Sono in genere deboli ed estesi e richiedono lunghe integrazioni.',
    inStarLight:
      'Il passo Oggetti riconosce l’oggetto ripreso dal nome nell’intestazione, dalle coordinate o dal contenuto dell’inquadratura, e ne mostra dimensione apparente, magnitudine, costellazione e una breve descrizione.',
    see: ['OpenNGC', 'Galassia', 'Nebulosa a emissione', 'Ammasso aperto']
  },
  {
    term: 'Galassia',
    alternatives: ['galassie', 'galaxy'],
    category: 'astrometry',
    definition:
      'Sistema di miliardi di stelle, gas e polveri legato dalla gravità, esterno alla Via Lattea. Nelle immagini presenta un nucleo luminoso e strutture esterne deboli, come i bracci a spirale, che richiedono una distensione attenta.',
    inStarLight:
      'Con la soluzione astrometrica le galassie del catalogo vengono segnate sull’immagine con un contorno commisurato alle loro dimensioni apparenti. Il pacchetto facoltativo «Galassie (SGA)» ne aggiunge molte altre, fino alla magnitudine 14.',
    see: ['Arp', 'Hickson', 'GHS']
  },
  {
    term: 'Nebulosa a emissione',
    alternatives: ['nebulosa', 'regione HII', 'nebulose a emissione'],
    category: 'astrometry',
    definition:
      'Nube di gas ionizzato dalla radiazione di stelle calde vicine, che emette luce in righe caratteristiche, soprattutto l’H-alfa dell’idrogeno, rossa. È il soggetto ideale per la ripresa a banda stretta.',
    inStarLight:
      'I cataloghi Sharpless, LBN, RCW e Gum, disponibili come pacchetti facoltativi, raccolgono molte nebulose a emissione non comprese nel catalogo NGC/IC.',
    see: ['H-alfa', 'Banda stretta', 'Sharpless', 'LBN']
  },
  {
    term: 'Nebulosa a riflessione',
    alternatives: ['nebulose a riflessione', 'reflection nebula'],
    category: 'astrometry',
    definition:
      'Nube di polvere che non emette luce propria ma diffonde quella delle stelle vicine, apparendo di solito azzurra. Non beneficia dei filtri a banda stretta.',
    inStarLight:
      'I cataloghi vdB e Cederblad, come pacchetti facoltativi, ne aggiungono molte al catalogo incluso.',
    see: ['vdB', 'Nebulosa a emissione']
  },
  {
    term: 'Nebulosa oscura',
    alternatives: ['nebulose oscure', 'dark nebula', 'nube oscura'],
    category: 'astrometry',
    definition:
      'Nube di polvere densa che oscura la luce delle stelle e delle nebulose retrostanti e appare come una sagoma scura sul fondo.',
    inStarLight:
      'I cataloghi di Barnard e LDN sono disponibili come pacchetti facoltativi.',
    see: ['Barnard', 'LDN']
  },
  {
    term: 'Nebulosa planetaria',
    alternatives: ['nebulose planetarie', 'planetary nebula', 'PN'],
    category: 'astrometry',
    definition:
      'Guscio di gas espulso da una stella simile al Sole nelle fasi finali della sua vita e illuminato dal nucleo stellare residuo. Il nome è storico e non ha relazione con i pianeti. Sono spesso piccole e ricche di OIII.',
    inStarLight:
      'Il pacchetto facoltativo «Nebulose planetarie» aggiunge quelle prive di sigla NGC o IC, comprese le planetarie del catalogo di Abell, con il diametro misurato.',
    see: ['OIII', 'Abell', 'PN G']
  },
  {
    term: 'Resto di supernova',
    alternatives: ['resti di supernova', 'supernova remnant', 'SNR'],
    category: 'astrometry',
    definition:
      'Nube di gas in espansione prodotta dall’esplosione di una stella come supernova, spesso formata da filamenti sottili che emettono in H-alfa e OIII.',
    inStarLight:
      'Il pacchetto facoltativo «Resti di supernova» raccoglie quelli della Via Lattea visibili anche in luce ottica, con dimensioni e struttura.',
    see: ['SNR G', 'Banda stretta']
  },
  {
    term: 'Ammasso aperto',
    alternatives: ['ammassi aperti', 'open cluster', 'ammasso stellare'],
    category: 'astrometry',
    definition:
      'Gruppo di stelle giovani nate dalla stessa nube, debolmente legate dalla gravità, sparse su un’area di cielo più o meno ampia.',
    inStarLight:
      'Il pacchetto facoltativo «Ammassi stellari da Gaia DR3» aggiunge circa settemila ammassi, con i nomi dei cataloghi storici Collinder, Melotte, Trumpler e altri.',
    see: ['Ammasso globulare', 'Catalogo Gaia']
  },
  {
    term: 'Ammasso globulare',
    alternatives: ['ammassi globulari', 'globular cluster', 'globulare'],
    category: 'astrometry',
    definition:
      'Raggruppamento sferico e compatto di centinaia di migliaia di stelle molto antiche, che orbita attorno al centro di una galassia.',
    inStarLight:
      'Il pacchetto facoltativo «Ammassi globulari della Via Lattea» li raccoglie con le rispettive dimensioni.',
    see: ['Ammasso aperto']
  },
  {
    term: 'Marcatori degli oggetti',
    alternatives: ['marcatori', 'etichette degli oggetti', 'annotazioni', 'overlay'],
    category: 'astrometry',
    definition:
      'Cerchi o ellissi con il nome, disegnati sull’immagine in corrispondenza degli oggetti di catalogo presenti nell’inquadratura.',
    inStarLight:
      'Con la soluzione astrometrica il visore segna gli oggetti riconosciuti; si mostrano o nascondono dal menu Visualizza o dal passo Oggetti. Nel passo Esporta l’opzione Includi i marcatori degli oggetti li disegna nei file PNG, JPEG e WebP.',
    see: ['Soluzione astrometrica', 'Oggetto del cielo profondo']
  },
  {
    term: 'Griglia delle coordinate',
    alternatives: ['griglia', 'griglia equatoriale', 'orientamento', 'barra di scala', 'nord ed est'],
    category: 'astrometry',
    definition:
      'Linee di ascensione retta e declinazione tracciate sull’immagine, con i valori lungo i bordi. Spesso è accompagnata dall’orientamento, cioè le direzioni del nord e dell’est nel cielo ripreso, e da una barra di scala con una misura angolare.',
    inStarLight:
      'Griglia, orientamento e barra di scala sono calcolati dalla soluzione astrometrica e si accendono separatamente nel passo Oggetti, nella scheda Coordinate sull’immagine; le scelte restano salvate. Orientamento e scala si dispongono nell’angolo lontano dalla didascalia. Nel passo Esporta l’opzione Includi le coordinate le disegna nei file PNG, JPEG e WebP.',
    see: ['Soluzione astrometrica', 'Ascensione retta', 'Declinazione', 'Marcatori degli oggetti']
  },
  {
    term: 'OpenNGC',
    alternatives: ['catalogo incluso', 'catalogo degli oggetti'],
    category: 'astrometry',
    definition:
      'Database libero degli oggetti dei cataloghi NGC e IC, con posizioni, dimensioni, magnitudini e designazioni incrociate con altri cataloghi, distribuito con licenza CC-BY-SA-4.0.',
    inStarLight:
      'Il catalogo incluso in StarLight deriva da OpenNGC, con circa tredicimila oggetti NGC e IC, i numeri Messier e Caldwell e nomi e descrizioni in italiano, integrato da una selezione di oggetti descritti con maggiore cura.',
    see: ['NGC', 'IC', 'Messier', 'Caldwell']
  },
  {
    term: 'Messier',
    alternatives: ['M', 'catalogo di Messier'],
    category: 'astrometry',
    definition:
      'Catalogo di 110 oggetti brillanti compilato nel Settecento da Charles Messier. Le sigle vanno da M 1 a M 110 e comprendono molti dei soggetti più noti, come M 31 (galassia di Andromeda) e M 42 (nebulosa di Orione).',
    inStarLight:
      'I numeri Messier fanno parte del catalogo incluso e vengono riconosciuti nei nomi degli oggetti.',
    see: ['OpenNGC', 'NGC', 'Caldwell']
  },
  {
    term: 'NGC',
    alternatives: ['New General Catalogue', 'Nuovo catalogo generale'],
    category: 'astrometry',
    definition:
      'New General Catalogue, compilato da J. L. E. Dreyer nel 1888, con circa 7800 oggetti del cielo profondo di tutti i tipi.',
    inStarLight:
      'È compreso nel catalogo incluso, tramite OpenNGC.',
    see: ['IC', 'OpenNGC']
  },
  {
    term: 'IC',
    alternatives: ['Index Catalogue', 'Catalogo indice'],
    category: 'astrometry',
    definition:
      'Index Catalogue, supplemento al catalogo NGC pubblicato da Dreyer fra il 1895 e il 1908, con oltre 5300 oggetti aggiuntivi.',
    inStarLight:
      'È compreso nel catalogo incluso, tramite OpenNGC.',
    see: ['NGC', 'OpenNGC']
  },
  {
    term: 'Caldwell',
    alternatives: ['C', 'catalogo Caldwell'],
    category: 'astrometry',
    definition:
      'Elenco di 109 oggetti brillanti compilato da Patrick Moore nel 1995 come complemento del catalogo di Messier, con sigle da C 1 a C 109 e molti oggetti dell’emisfero australe.',
    inStarLight:
      'I numeri Caldwell fanno parte del catalogo incluso.',
    see: ['Messier', 'OpenNGC']
  },
  {
    term: 'Cataloghi deep sky aggiuntivi',
    alternatives: ['pacchetti di cataloghi', 'cataloghi facoltativi', 'cataloghi deep sky'],
    category: 'astrometry',
    definition:
      'Raccolte di oggetti di altri cataloghi astronomici, distribuite come pacchetti di soli dati con licenza aperta.',
    inStarLight:
      'La galleria dei plugin, alla voce Cataloghi deep sky, permette di scaricare dal server di StarLight, o di installare da un archivio ZIP, cataloghi come Sharpless, LBN, LDN, Barnard, vdB, Arp, Hickson, nebulose planetarie, resti di supernova e ammassi. Ogni pacchetto viene verificato prima dell’installazione; gli oggetti installati si riconoscono nel campo, si segnano sull’immagine e si trovano per sigla. Un catalogo installato si può disattivare (resta sul disco ma non viene usato) e riattivare, oppure disinstallare. Nel passo Oggetti la densità dei marcatori (Essenziale, Normale, Ricca) e i tipi di oggetto mostrati evitano che i campi ricchi si riempiano di nomi. Nella stessa galleria, il gruppo Stelle per la risoluzione del campo offre le stelle per risolvere il campo senza internet.',
    see: ['Sharpless', 'LBN', 'LDN', 'Barnard', 'vdB', 'Arp', 'Hickson', 'Stelle locali', 'Galleria dei plugin']
  },
  {
    term: 'Sharpless',
    alternatives: ['Sh2', 'Sh 2', 'SH2', 'catalogo Sharpless'],
    category: 'astrometry',
    definition:
      'Catalogo di 313 nebulose a emissione (regioni HII) dell’emisfero boreale, pubblicato da Stewart Sharpless nel 1959. Le sigle hanno la forma Sh2-155.',
    inStarLight:
      'È disponibile come pacchetto facoltativo nella scheda Cataloghi deep sky della galleria dei plugin.',
    see: ['Nebulosa a emissione', 'Cataloghi deep sky aggiuntivi']
  },
  {
    term: 'LBN',
    alternatives: ['Lynds Bright Nebulae', 'nebulose brillanti di Lynds'],
    category: 'astrometry',
    definition:
      'Catalogo delle nebulose brillanti compilato da Beverly Lynds nel 1965 a partire dalle lastre fotografiche della Palomar Sky Survey.',
    inStarLight:
      'È disponibile come pacchetto facoltativo nella scheda Cataloghi deep sky della galleria dei plugin.',
    see: ['LDN', 'Nebulosa a emissione', 'Cataloghi deep sky aggiuntivi']
  },
  {
    term: 'LDN',
    alternatives: ['Lynds Dark Nebulae', 'nebulose oscure di Lynds'],
    category: 'astrometry',
    definition:
      'Catalogo delle nebulose oscure compilato da Beverly Lynds nel 1962.',
    inStarLight:
      'È disponibile come pacchetto facoltativo nella scheda Cataloghi deep sky della galleria dei plugin.',
    see: ['LBN', 'Nebulosa oscura', 'Barnard']
  },
  {
    term: 'Barnard',
    alternatives: ['B', 'catalogo di Barnard'],
    category: 'astrometry',
    definition:
      'Catalogo di nebulose oscure compilato da Edward Emerson Barnard all’inizio del Novecento; comprende, per esempio, la nebulosa Testa di Cavallo (Barnard 33).',
    inStarLight:
      'È disponibile come pacchetto facoltativo nella scheda Cataloghi deep sky della galleria dei plugin.',
    see: ['Nebulosa oscura', 'LDN']
  },
  {
    term: 'vdB',
    alternatives: ['van den Bergh', 'catalogo van den Bergh'],
    category: 'astrometry',
    definition:
      'Catalogo di 158 nebulose a riflessione pubblicato da Sidney van den Bergh nel 1966.',
    inStarLight:
      'È disponibile come pacchetto facoltativo nella scheda Cataloghi deep sky della galleria dei plugin; le posizioni non comprendono le dimensioni.',
    see: ['Nebulosa a riflessione', 'Cataloghi deep sky aggiuntivi']
  },
  {
    term: 'RCW, Gum e Cederblad',
    alternatives: ['RCW', 'Gum', 'Cederblad', 'Ced'],
    category: 'astrometry',
    definition:
      'Cataloghi storici di nebulose: RCW (Rodgers, Campbell e Whiteoak, 1960) e Gum (1955) raccolgono le nebulose a emissione del cielo australe; Cederblad (1946) le nebulose diffuse, in gran parte a riflessione.',
    inStarLight:
      'Sono disponibili come pacchetti facoltativi nella scheda Cataloghi deep sky della galleria dei plugin.',
    see: ['Nebulosa a emissione', 'Nebulosa a riflessione']
  },
  {
    term: 'Abell',
    alternatives: ['catalogo di Abell', 'Abell PN'],
    category: 'astrometry',
    definition:
      'Nome di due cataloghi compilati da George Abell: uno di 86 nebulose planetarie deboli ed estese, l’altro di migliaia di ammassi di galassie. La sigla, per esempio Abell 39, va interpretata secondo il tipo di oggetto.',
    inStarLight:
      'Le planetarie di Abell sono comprese nel pacchetto «Nebulose planetarie»; le sigle Abell degli ammassi compaiono nel pacchetto «Ammassi di galassie vicini».',
    see: ['Nebulosa planetaria', 'Hickson']
  },
  {
    term: 'Arp',
    alternatives: ['Atlas of Peculiar Galaxies', 'galassie peculiari'],
    category: 'astrometry',
    definition:
      'Atlante di 338 galassie peculiari, spesso interagenti o deformate, pubblicato da Halton Arp nel 1966.',
    inStarLight:
      'È disponibile come pacchetto facoltativo nella scheda Cataloghi deep sky della galleria dei plugin.',
    see: ['Galassia', 'Hickson']
  },
  {
    term: 'Hickson',
    alternatives: ['HCG', 'Hickson Compact Groups', 'gruppi compatti'],
    category: 'astrometry',
    definition:
      'Catalogo di 100 gruppi compatti di galassie, formati da quattro o più galassie molto vicine fra loro, compilato da Paul Hickson nel 1982. Le sigle hanno la forma HCG 92.',
    inStarLight:
      'È disponibile come pacchetto facoltativo nella scheda Cataloghi deep sky della galleria dei plugin.',
    see: ['Galassia', 'Arp']
  },
  {
    term: 'PN G',
    alternatives: ['designazione galattica', 'PK'],
    category: 'astrometry',
    definition:
      'Designazione delle nebulose planetarie basata sulle coordinate galattiche, per esempio PN G054.1-12.1: le cifre indicano longitudine e latitudine galattica dell’oggetto.',
    inStarLight:
      'Le sigle PN G possono comparire fra i nomi alternativi degli oggetti del pacchetto «Nebulose planetarie».',
    see: ['Nebulosa planetaria', 'SNR G']
  },
  {
    term: 'SNR G',
    alternatives: ['SNR', 'designazione dei resti di supernova'],
    category: 'astrometry',
    definition:
      'Designazione dei resti di supernova basata sulle coordinate galattiche, per esempio SNR G180.0-01.7. La stessa sigla SNR è usata anche come abbreviazione inglese del rapporto segnale/rumore, con cui non ha relazione.',
    inStarLight:
      'Le sigle SNR G possono comparire fra i nomi alternativi degli oggetti del pacchetto «Resti di supernova».',
    see: ['Resto di supernova', 'PN G', 'Rapporto segnale/rumore']
  },

  // ---------------------------------------------------------------- Plugins
  {
    term: 'Plugin',
    alternatives: ['strumenti aggiuntivi', 'estensioni', 'add-on'],
    category: 'plugins',
    definition:
      'Strumento aggiuntivo installabile separatamente, che estende le funzioni del programma senza modificarlo.',
    inStarLight:
      'I plugin inclusi attivati dalla galleria e quelli personali installati compaiono nella scheda Strumenti aggiuntivi del passo Elabora e vengono applicati dopo tutti gli altri strumenti, nell’ordine di accensione. Ogni plugin lavora isolato dal resto del programma, senza accesso ai file né a internet. StarLight non scarica plugin da internet: quelli personali si installano da una cartella o da un archivio .zip.',
    see: ['Galleria dei plugin']
  },
  {
    term: 'Galleria dei plugin',
    alternatives: ['galleria', 'menu Plugin'],
    category: 'plugins',
    definition:
      'Finestra che raccoglie i plugin disponibili, con descrizione e anteprime del risultato.',
    inStarLight:
      'Si apre dal menu Plugin e funziona anche senza internet. Contiene i plugin inclusi in StarLight, che si attivano e si disattivano (la scelta resta alle aperture successive), e la scheda Cataloghi deep sky con i cataloghi facoltativi; le schede Tutti e Attivi mostrano plugin e cataloghi insieme. Il server di StarLight ospita solo i pacchetti di FM Digital Tools: i plugin personali e quelli di altri sviluppatori si installano da una cartella o da un archivio ZIP.',
    see: ['Plugin', 'Cataloghi deep sky aggiuntivi']
  },
  {
    term: 'Effetto Orton',
    alternatives: ['Orton', 'bagliore', 'glow'],
    category: 'plugins',
    definition:
      'Tecnica fotografica che fonde un’immagine nitida con una sua copia schiarita e sfocata, producendo un bagliore diffuso attorno alle zone luminose e un aspetto più morbido. Prende il nome dal fotografo Michael Orton, che la otteneva sovrapponendo due diapositive.',
    inStarLight:
      'Il plugin Effetto Orton regola l’intensità del bagliore, la sua ampiezza in pixel e la schiarita della copia sfocata. Sulle nebulose produce un aspetto più morbido mantenendo leggibili i contorni.',
    see: ['Plugin']
  },
  {
    term: 'Rimozione del verde',
    alternatives: ['SCNR', 'Subtractive Chromatic Noise Reduction', 'riduzione sottrattiva del rumore cromatico', 'verde in eccesso'],
    category: 'plugins',
    definition:
      'Correzione della dominante verde tipica delle astrofotografie a colori: in cielo quasi nessun oggetto è realmente verde, quindi un eccesso di verde è di solito un artefatto. Il metodo SCNR (riduzione sottrattiva del rumore cromatico) limita il verde di ogni pixel a un valore di riferimento calcolato da rosso e blu.',
    inStarLight:
      'Il plugin Rimozione del verde offre i metodi Media neutra (verde limitato alla media di rosso e blu, consigliato) e Massimo neutro (limitato al maggiore dei due, per dominanti lievi), il cursore Quantità e l’opzione Conserva la luminosità, che compensa il leggero scurimento prodotto dalla correzione.',
    see: ['Dominante di colore', 'Plugin']
  },
  {
    term: 'Negativo',
    alternatives: ['inversione', 'immagine invertita', 'invert'],
    category: 'plugins',
    definition:
      'Inversione dei valori di luminosità, per cui il fondo cielo diventa chiaro e le stelle punti scuri. Facilita l’individuazione delle estensioni più deboli di nebulose e galassie, perché l’occhio distingue meglio le sfumature scure su fondo chiaro.',
    inStarLight:
      'Il plugin Negativo inverte luce e colori (ogni colore diventa il complementare) oppure solo la luce, conservando le tinte. È calcolato sulla distensione impostata nel passo Correggi.',
    see: ['Plugin']
  },
  {
    term: 'Bianco e nero per canale',
    alternatives: ['bianco e nero', 'monocromatico', 'conversione in bianco e nero', 'scala di grigi'],
    category: 'plugins',
    definition:
      'Conversione in bianco e nero in cui ciascun canale di colore contribuisce con un peso regolabile, in modo analogo ai filtri colorati usati con la pellicola. Un peso maggiore del rosso mette in risalto le nebulose a emissione, uno maggiore del blu le nebulose a riflessione e le stelle giovani.',
    inStarLight:
      'Il plugin Bianco e nero per canale ha un cursore per ciascun canale e l’opzione Mantieni la luminosità, che riporta la somma dei pesi al 100%.',
    see: ['Canale di colore', 'Plugin']
  },
  {
    term: 'HDR, recupero delle zone luminose',
    alternatives: ['HDR', 'high dynamic range', 'compressione della gamma dinamica', 'recupero delle luci'],
    category: 'plugins',
    definition:
      'Compressione della gamma dinamica limitata alle zone più luminose, che ne restituisce il dettaglio senza scurire le parti deboli. È utile quando la distensione necessaria a mostrare le strutture tenui porta al bianco i nuclei e le regioni brillanti.',
    inStarLight:
      'Il plugin HDR interviene sopra una soglia di luminosità regolabile, sulle strutture della dimensione indicata, e può rinforzare il contrasto locale nelle zone compresse; i colori mantengono le proporzioni. Recupera solo il dettaglio presente nei dati: una zona satura in ogni scatto resta uniforme.',
    see: ['Gamma dinamica', 'Pixel saturi', 'Contrasto locale']
  },
  {
    term: 'Separazione di stelle e nebulosa',
    alternatives: ['starless', 'immagine senza stelle', 'rimozione delle stelle', 'strato delle stelle'],
    category: 'plugins',
    definition:
      'Suddivisione dell’immagine in due strati, uno con la sola nebulosa e uno con le sole stelle, che possono essere regolati separatamente e poi ricomposti. Consente, per esempio, di aumentare luminosità e saturazione della nebulosa senza ingrandire le stelle.',
    inStarLight:
      'Il plugin Separazione di stelle e nebulosa usa un metodo classico di morfologia matematica e interpolazione, senza intelligenza artificiale. Restituisce l’immagine ricomposta, la sola nebulosa o le sole stelle, con cursori per raggio massimo delle stelle, sensibilità, margine e per luminosità, saturazione e riduzione di ciascuno strato.',
    see: ['Riduzione delle stelle', 'Plugin']
  },
  {
    term: 'Rimozione degli aloni viola e blu',
    alternatives: ['aloni viola', 'aloni blu', 'frange colorate', 'correzione dell’aberrazione cromatica'],
    category: 'plugins',
    definition:
      'Correzione dell’alone viola o blu che l’aberrazione cromatica forma attorno alle stelle. In un’ottica senza aberrazione la luce di una stella ha lo stesso colore dal centro al bordo; dove il bordo ha più blu o più rosso di quanto il colore della stella preveda, l’eccesso è frangia.',
    inStarLight:
      'Il plugin individua le stelle, misura il colore della parte interna di ciascuna e sottrae dal bordo la sola luce colorata in eccesso, senza aggiungerne: il centro conserva il suo colore e la nebulosa resta invariata. Ha i cursori Intensità e Ampiezza dell’alone e la scelta della tinta da correggere, solo viola e blu oppure tutte.',
    see: ['Aberrazione cromatica', 'Plugin']
  },
  {
    term: 'Riduzione degli aloni delle stelle brillanti',
    alternatives: ['riduzione degli aloni', 'aloni delle stelle', 'rimozione degli aloni'],
    category: 'plugins',
    definition:
      'Attenuazione dell’alone largo che circonda le stelle più luminose. L’alone ha simmetria circolare e varia lentamente con la distanza dalla stella: si misura con il profilo radiale e si sottrae, restituendo il fondo e la nebulosa che copriva.',
    inStarLight:
      'Il plugin tratta solo le stelle più luminose della soglia scelta, misura per ciascuna la mediana di anelli concentrici fino all’ampiezza indicata e sottrae l’alone a partire dal bordo della stella: il disco della stella resta identico. Diversamente dalla riduzione delle stelle, non cambia le dimensioni delle stelle.',
    see: ['Alone delle stelle', 'Riduzione delle stelle', 'Plugin']
  },
  {
    term: 'Colore delle stelle',
    alternatives: ['stelle bianche', 'saturazione delle stelle', 'colore stellare'],
    category: 'plugins',
    definition:
      'Ripristino del colore nel centro delle stelle che la distensione ha portato al bianco. Il colore resta registrato nella corona della stella, dove i canali non raggiungono il bianco, e si può riportare nella parte centrale.',
    inStarLight:
      'Il plugin misura il colore di ogni stella nella corona, sui dati lineari e al netto del fondo, e lo applica alla parte centrale abbassando i canali più deboli. Agisce solo all’interno delle stelle; i cursori regolano l’intensità, la dimensione minima delle stelle trattate e la protezione dei pixel saturi, che possono restare bianchi.',
    see: ['Saturazione', 'Pixel saturi', 'Distensione', 'Plugin']
  },
  {
    term: 'Spighe di diffrazione',
    alternatives: ['spighe', 'punte di diffrazione', 'diffraction spikes', 'crociera', 'raggi delle stelle'],
    category: 'plugins',
    definition:
      'Punte luminose a raggiera attorno alle stelle brillanti, prodotte dalla diffrazione della luce sui sostegni dello specchio secondario dei telescopi a riflessione. Ogni sostegno diritto produce due punte perpendicolari a sé stesso: una crociera a quattro bracci dà quattro punte, tre sostegni ne danno sei. Gli strumenti senza ostruzione, come i rifrattori, non le producono.',
    inStarLight:
      'Il plugin Spighe di diffrazione le aggiunge come effetto estetico alle stelle più luminose sopra una soglia, fino a un numero massimo: 4, 6 o 8 punte, con angolo, lunghezza, spessore e intensità regolabili. Le punte sono più lunghe sulle stelle più brillanti, si attenuano verso l’estremità, possono prendere il colore della stella e, con la dispersione dei colori, virare leggermente al rosso verso la punta. Non derivano dai dati della ripresa.',
    see: ['Plugin']
  },
  {
    term: 'Colorazione di un’immagine monocromatica',
    alternatives: ['colorazione', 'tinta', 'monocromatica colorata', 'colorize'],
    category: 'plugins',
    definition:
      'Attribuzione di una tinta uniforme a un’immagine in bianco e nero, per esempio quella ripresa con un filtro a banda stretta, in modo che ogni pixel mantenga la sua luminosità. È d’uso dare a ciascuna ripresa il colore della riga di emissione raccolta.',
    inStarLight:
      'Il plugin Colorazione delle immagini monocromatiche propone le tinte delle righe H-alfa, H-beta e OIII, calcolate dalla lunghezza d’onda della riga, oppure una tinta libera, con un cursore di saturazione. La luminosità come appare a schermo resta identica; nelle zone più chiare la tinta sfuma verso il bianco.',
    see: ['Banda stretta', 'H-alfa', 'OIII', 'Plugin']
  },
  {
    term: 'Viraggio',
    alternatives: ['viraggio separato', 'split toning', 'toni divisi', 'viraggio di ombre e luci'],
    category: 'plugins',
    definition:
      'Tecnica della stampa fotografica che dà una tinta all’immagine; nel viraggio separato le parti scure e quelle chiare ricevono tinte diverse, spesso fredda la prima e calda la seconda. Cambia l’atmosfera dell’immagine senza cambiarne la luminosità.',
    inStarLight:
      'Il plugin Viraggio di ombre e luci ha una tinta e un’intensità per le ombre e per le luci e un bilanciamento che sposta il passaggio fra le due. La luminosità di ogni pixel resta invariata, le stelle sature restano bianche e, con l’opzione Proteggi il fondo cielo, i pixel del fondo restano identici.',
    see: ['Fondo cielo', 'Plugin']
  },
  {
    term: 'Falsi colori',
    alternatives: ['falso colore', 'false color', 'mappa di colori', 'colormap', 'viridis', 'magma', 'inferno', 'plasma', 'tavolozza percettivamente uniforme'],
    category: 'plugins',
    definition:
      'Rappresentazione in cui il colore di ogni pixel indica la sua luminosità secondo una scala prestabilita, anziché il colore reale. Le tavolozze percettivamente uniformi, come viridis, magma, inferno e plasma, sono progettate perché la chiarezza percepita cresca in modo regolare lungo la scala: differenze di luminosità uguali appaiono come differenze di colore uguali, e l’ordine si legge anche con una visione dei colori ridotta. Servono all’analisi, per vedere strutture deboli e gradienti del fondo.',
    inStarLight:
      'Il plugin Falsi colori per luminosità offre le tavolozze viridis, magma, inferno e plasma (pubblico dominio, CC0) e tre scale: come appare a schermo, lineare e logaritmica. Le ultime due si calcolano sui dati lineari, dal fondo cielo alle zone più luminose; la logaritmica dedica gran parte dei colori alle parti deboli. L’opzione Stelle in bianco e nero lascia le stelle in grigio.',
    see: ['Distensione', 'Fondo cielo', 'Plugin']
  },

  // ---------------------------------------------------------------- Export and formats
  {
    term: 'FITS',
    alternatives: ['.fit', '.fits', '.fts', '.fz', 'FITS compresso', 'Flexible Image Transport System'],
    category: 'export',
    definition:
      'Sigla di Flexible Image Transport System, il formato standard dell’astronomia per immagini e dati scientifici. Un file FITS contiene un’intestazione testuale con i dati di scatto e i dati dell’immagine, a 8, 16 o 32 bit interi o in virgola mobile. Esistono varianti compresse (.fz e .gz).',
    inStarLight:
      'StarLight importa i file FITS, anche compressi: .fits.gz e .fz con tutti i metodi previsti dallo standard (Rice, gzip, HCOMPRESS, anche con perdita, e PLIO). Esporta in FITS a sedici bit; l’opzione Conserva i dati di scatto copia nel nuovo file le parole chiave del FITS di partenza.',
    see: ['Intestazione', 'XISF', 'Profondità di bit']
  },
  {
    term: 'XISF',
    alternatives: ['.xisf', 'Extensible Image Serialization Format'],
    category: 'export',
    definition:
      'Sigla di Extensible Image Serialization Format: formato aperto per immagini astronomiche con intestazione in XML, che può contenere anche le parole chiave FITS.',
    inStarLight:
      'StarLight importa i file XISF, anche compressi con zlib, LZ4 o Zstandard, anche dalla cartella della sessione dal vivo, e ne legge i dati di scatto.',
    see: ['FITS', 'Intestazione']
  },
  {
    term: 'RAW',
    alternatives: ['file grezzo', 'CR2', 'CR3', 'NEF', 'ARW', 'RAF', 'ORF', 'RW2', 'PEF', 'DNG'],
    category: 'export',
    definition:
      'File che contiene i dati del sensore di una fotocamera così come sono stati letti, prima di qualsiasi ricostruzione del colore o compressione. Ogni marca ha il proprio formato (CR2 e CR3, NEF, ARW, RAF, ORF, RW2, PEF, DNG e altri).',
    inStarLight:
      'StarLight importa i RAW delle principali fotocamere reflex e mirrorless, ne legge i dati di scatto e ricostruisce il colore dalla matrice di Bayer o X-Trans. I RAW sono accettati anche dalla sessione dal vivo.',
    see: ['Matrice di Bayer', 'X-Trans', 'FITS']
  },
  {
    term: 'TIFF',
    alternatives: ['.tif', '.tiff', 'Tagged Image File Format'],
    category: 'export',
    definition:
      'Formato di immagine senza perdita di qualità, adatto allo scambio fra programmi di fotoritocco, che conserva fino a sedici bit per canale.',
    inStarLight:
      'StarLight importa immagini TIFF ed esporta in TIFF a sedici bit per canale.',
    see: ['Profondità di bit', 'PNG']
  },
  {
    term: 'PNG',
    alternatives: ['.png', 'Portable Network Graphics'],
    category: 'export',
    definition:
      'Formato di immagine con compressione senza perdita, molto diffuso sul web.',
    inStarLight:
      'StarLight importa ed esporta immagini PNG; in esportazione può includere i marcatori degli oggetti.',
    see: ['Compressione', 'TIFF']
  },
  {
    term: 'JPEG',
    alternatives: ['.jpg', '.jpeg', 'JPG'],
    category: 'export',
    definition:
      'Formato di immagine con compressione con perdita, che produce file leggeri a otto bit per canale, adatti alla condivisione ma non a ulteriori elaborazioni.',
    inStarLight:
      'È disponibile solo in esportazione, con il cursore Qualità; oltre il 90% la perdita è difficilmente percepibile. Può includere i marcatori degli oggetti.',
    see: ['Compressione', 'WebP']
  },
  {
    term: 'WebP',
    alternatives: ['.webp'],
    category: 'export',
    definition:
      'Formato di immagine per il web con compressione efficiente, che a parità di qualità produce file più leggeri del JPEG.',
    inStarLight:
      'È disponibile in esportazione, con il cursore Qualità e l’opzione dei marcatori degli oggetti.',
    see: ['JPEG', 'Compressione']
  },
  {
    term: 'BMP',
    alternatives: ['.bmp', 'bitmap'],
    category: 'export',
    definition:
      'Formato di immagine non compresso, semplice e compatibile con quasi tutti i programmi, a otto bit per canale.',
    inStarLight:
      'È disponibile in esportazione.',
    see: ['PNG']
  },
  {
    term: 'Compressione',
    alternatives: ['senza perdita', 'con perdita', 'lossless', 'lossy'],
    category: 'export',
    definition:
      'Riduzione delle dimensioni di un file. La compressione senza perdita (PNG, TIFF) conserva esattamente ogni pixel; quella con perdita (JPEG, WebP) elimina dettagli poco visibili e può introdurre artefatti, tanto più quanto più è spinta.',
    inStarLight:
      'Per i formati con perdita il passo Esporta offre il cursore Qualità.',
    see: ['PNG', 'JPEG', 'WebP', 'TIFF']
  },
  {
    term: 'Profondità di bit',
    alternatives: ['bit depth', 'BITPIX', '8 bit', '16 bit', '32 bit', 'virgola mobile'],
    category: 'export',
    definition:
      'Numero di bit con cui è registrato il valore di ciascun pixel per canale: 8 bit consentono 256 livelli, 16 bit 65.536 livelli. Le immagini astronomiche richiedono molti livelli, perché la distensione amplifica fortemente le piccole differenze fra i toni deboli; con pochi livelli compaiono bande e scalini.',
    inStarLight:
      'Il passo Importa mostra la profondità di ogni file. StarLight elabora internamente in virgola mobile a 32 bit; TIFF e FITS esportati conservano sedici bit per canale.',
    see: ['Gamma dinamica', 'FITS', 'TIFF']
  },
  {
    term: 'Intestazione',
    alternatives: ['header', 'parole chiave', 'keyword', 'dati di scatto', 'metadati'],
    category: 'export',
    definition:
      'Parte di un file FITS o XISF che contiene i dati di scatto come coppie di parola chiave e valore: data e ora, posa, guadagno, temperatura, filtro, focale, coordinate di puntamento, nome dell’oggetto, schema di Bayer, eventuale soluzione astrometrica.',
    inStarLight:
      'All’importazione StarLight legge soltanto l’intestazione dei file, quindi anche centinaia di file vengono caricati in pochi istanti; i dati principali sono mostrati nel passo Importa. Dall’intestazione dipendono il riconoscimento del tipo di frame, la ricostruzione del colore, la scelta dei master, il riconoscimento dell’oggetto e la scala del campo.',
    see: ['IMAGETYP', 'FITS', 'WCS']
  },
  {
    term: 'IMAGETYP',
    alternatives: ['tipo di frame', 'FRAME', 'OBSTYPE', 'image type'],
    category: 'export',
    definition:
      'Parola chiave dell’intestazione FITS che dichiara il tipo di frame: luce (Light), dark, flat o bias. Non tutti i dispositivi la compilano in modo coerente.',
    inStarLight:
      'StarLight usa IMAGETYP come fonte principale per classificare i frame e il nome del file come conferma: un nome che contiene «dark», «flat» o «bias» viene riconosciuto anche senza la parola chiave. Un file che dichiara più frame combinati è riconosciuto come già impilato.',
    see: ['Intestazione', 'Frame di luce', 'Frame di calibrazione']
  },
  {
    term: 'Ricampionamento',
    alternatives: ['ingrandimento', 'ridimensionamento', 'upscaling', 'Lanczos', 'Contorni', 'interpolazione'],
    category: 'export',
    definition:
      'Calcolo di un’immagine con un numero di pixel diverso dall’originale. Per l’ingrandimento il filtro di Lanczos è il metodo classico, nitido e fedele, ma sui bordi obliqui può lasciare piccoli gradini e aloni scuri attorno alle stelle brillanti; i metodi che seguono la direzione dei bordi li evitano. Nessun metodo aggiunge dettagli assenti nei dati.',
    inStarLight:
      'Nel passo Esporta, scheda Risoluzione, si sceglie fra Lanczos e Contorni, che interpola lungo la direzione dei bordi mantenendo lisci profili stellari e contorni delle nebulose. Le correzioni vengono ricalcolate sui dati originali a piena risoluzione.',
    see: ['Ritaglio', 'Drizzle']
  },

  // ---------------------------------------------------------------- Using the program
  {
    term: 'Progetto',
    alternatives: ['.slight', 'project.slight', 'salvataggio'],
    category: 'usage',
    definition:
      'Insieme del lavoro svolto su un’immagine, salvato per poterlo riprendere in un secondo momento.',
    inStarLight:
      'Ogni progetto è una cartella con il nome scelto, che contiene il file project.slight con le regolazioni e l’immagine elaborata. I frame originali non vengono copiati e restano nella loro posizione. I comandi sono nel menu File; la voce Progetti recenti elenca gli ultimi cinque.',
    see: ['Libreria dei frame', 'Cronologia']
  },
  {
    term: 'Libreria dei frame',
    alternatives: ['libreria', 'elenco dei frame', 'frame importati'],
    category: 'usage',
    definition:
      'Elenco dei file importati in una sessione di lavoro, con il tipo e i dati di scatto di ciascuno.',
    inStarLight:
      'Nel passo Importa un clic su un frame lo apre nel visore; il pulsante con l’occhio lo esclude dall’elaborazione senza rimuoverlo. I frame di calibrazione della libreria alimentano il passo Calibra, quelli di luce il passo Impila.',
    see: ['Frame di luce', 'Frame di calibrazione', 'Progetto']
  },
  {
    term: 'Cronologia',
    alternatives: ['annulla', 'ripeti', 'storico delle modifiche', 'history', 'undo'],
    category: 'usage',
    definition:
      'Registro ordinato delle modifiche apportate all’immagine, che consente di tornare a uno stato precedente.',
    inStarLight:
      'Ogni modifica diventa un passo della cronologia: regolazioni, curve, elaborazioni, Abracadabra, plugin e ritaglio. Ctrl+Z e Ctrl+Y annullano e ripetono; il pulsante Cronologia apre l’elenco dei passi. Aprire un altro frame o un progetto fa ripartire la cronologia.',
    see: ['Progetto', 'Abracadabra']
  },
  {
    term: 'Elaborazione in serie',
    alternatives: ['batch', 'elaborazione batch', 'serie'],
    category: 'usage',
    definition:
      'Applicazione della stessa sequenza di correzioni a più immagini, con un file in uscita per ciascuna.',
    inStarLight:
      'Dal menu File, Elaborazione in serie applica una ricetta a più file FITS, XISF, TIFF, PNG o RAW, uno alla volta, oppure prepara ciascuno con Abracadabra. I file vanno nella cartella delle esportazioni, in una sottocartella con la data, senza mai sovrascrivere file esistenti. L’immagine aperta e il progetto non vengono toccati.',
    see: ['Ricetta', 'Abracadabra']
  },
  {
    term: 'Ricetta',
    alternatives: ['.recipe', 'preimpostazione', 'preset di elaborazione'],
    category: 'usage',
    definition:
      'Insieme salvato di regolazioni da applicare ad altre immagini.',
    inStarLight:
      'La ricetta dell’elaborazione in serie comprende gli strumenti di Elabora, toni e colore, curve, filtro, inquadratura e formato del file. Si ricava dall’immagine aperta e si salva in un file .recipe da riaprire in seguito.',
    see: ['Elaborazione in serie']
  }
]
