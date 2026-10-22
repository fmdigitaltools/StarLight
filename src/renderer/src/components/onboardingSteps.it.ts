/**
 * Quick tour steps in Italian (reference language).
 *
 * `onboardingSteps.en.ts` holds the same steps, in the same order, in English.
 * The first step's text contains the `{version}` and `{codename}` placeholders,
 * filled by Onboarding when rendering.
 */

export interface GuideStep {
  /** Element to highlight, identified by its data-guide attribute. */
  target: string | null
  title: string
  text: string
  /** Workflow step to select before showing this bubble. */
  workflowStep?: 'import' | 'correct' | 'filters' | 'objects' | 'export'
}

export const ONBOARDING_STEPS_IT: GuideStep[] = [
  {
    target: null,
    title: 'Benvenuto in StarLight',
    text:
      'Questa è la versione {version}, nome in codice {codename}. StarLight è un programma per l’elaborazione delle immagini astronomiche, pensato in primo luogo per le riprese impilate e in grado di assistere anche nel miglioramento delle singole immagini. Accetta file FITS e XISF, immagini TIFF e PNG e i formati RAW delle fotocamere. Questa guida mostra dove si trovano i comandi principali. Puoi chiuderla in qualsiasi momento e rivederla dalla Guida, che si apre con il tasto F1, con il pulsante Rivedi la guida rapida.'
  },
  {
    target: 'import-actions',
    title: 'L’importazione dei frame',
    text:
      'Con Importa frame carichi i singoli scatti salvati dal telescopio o dalla fotocamera, con Cartella tutti i frame di una sessione. Telescopio apre la scelta dei frame direttamente nella cartella del telescopio, anche in rete, se l’hai indicata nelle Impostazioni. In questa fase StarLight legge soltanto l’intestazione dei file, cioè i dati di scatto, quindi anche centinaia di file arrivano in pochi istanti.'
  },
  {
    target: 'viewer',
    title: 'Il visore',
    text:
      'Qui vedi l’immagine su cui lavori. Trascina con il mouse per spostarla e usa la rotella per ingrandire: il tasto 0 la adatta alla finestra, il tasto 1 mostra i pixel reali. Le regolazioni dei passi Correggi e Filtri le calcola la scheda grafica, quindi l’immagine cambia mentre muovi i cursori.'
  },
  {
    target: 'history-actions',
    title: 'Gli strumenti in cima',
    text:
      'Indietro e Avanti annullano e ripetono le modifiche, Ripristina riporta l’immagine com’era appena aperta e Cronologia mostra tutti i passaggi fatti. Seguono la rotazione di 90° e lo specchio, Raddrizza per ruotare di un angolo qualsiasi o mettere il nord in alto, lo zoom con Adatta e il Ritaglio, che mostra nel visore la parte dell’immagine che esporterai.'
  },
  {
    target: 'workflow',
    title: 'Il flusso di lavoro',
    text:
      'Gli otto passi si seguono in ordine, dall’alto verso il basso: Importa, Calibra, Impila, Elabora, Correggi, Filtri, Oggetti ed Esporta. Calibra e Impila lavorano sui frame, gli altri sull’immagine aperta. Un passo resta spento finché non importi un frame oppure, per i passi che lavorano sull’immagine, finché non ne apri una nel visore.'
  },
  {
    target: 'step-align',
    title: 'Impilare',
    text:
      'È il passaggio con l’effetto maggiore sul risultato finale. StarLight individua le stelle di ogni scatto, misura lo spostamento e la rotazione del campo, scarta i frame mossi e somma i rimanenti. Il rumore cala con la radice quadrata del numero di frame: con cento scatti diventa dieci volte più basso. Nello stesso passo trovi il drizzle, la fusione HDR, la sessione dal vivo durante la ripresa e il mosaico.'
  },
  {
    target: 'step-process',
    title: 'Elabora',
    text:
      'Elabora contiene gli strumenti che lavorano sui dati prima della distensione, cioè della trasformazione che rende visibili i toni deboli. Ogni scheda tratta un problema preciso: fondo cielo, colore, nitidezza, rumore, stelle, contrasto. In fondo trovi gli strumenti aggiuntivi, cioè i plugin. Applica esegue il calcolo, sempre a partire dall’immagine originale.'
  },
  {
    target: 'image-actions',
    title: 'Abracadabra',
    text:
      'Abracadabra misura l’immagine, regola da solo gli strumenti di Elabora e la distensione ed esegue l’intera elaborazione. Il risultato è un punto di partenza: i valori scelti restano modificabili nei passi Elabora e Correggi, e Ripristina riporta l’immagine all’originale.'
  },
  {
    target: 'panel',
    title: 'Gli strumenti del passo',
    text:
      'Qui compaiono soltanto i comandi del passo selezionato. Se fermi il puntatore del mouse sopra un cursore, compare una spiegazione di cosa fa e di quando conviene usarlo.',
    workflowStep: 'correct'
  },
  {
    target: 'tab-stretch',
    title: 'La distensione',
    text:
      'Un frame grezzo appare nero perché il segnale occupa una frazione minima della scala del sensore. La distensione, nel passo Correggi, schiarisce i toni deboli e rende visibile l’oggetto. Auto calcola quella adatta all’immagine e i cursori sotto ti permettono di rifinirla. In alternativa ai mezzitoni, la distensione iperbolica generalizzata (GHS) concentra il contrasto su una fascia di luminosità che scegli tu.',
    workflowStep: 'correct'
  },
  {
    target: 'step-filters',
    title: 'I filtri',
    text:
      'Filtri raccoglie le rifiniture finali, calcolate in tempo reale dalla scheda grafica: i filtri fotografici, la riduzione del rumore, la nitidezza dei dettagli, la vignettatura e la rimozione del fondo. Ogni regolazione si vede subito nel visore e si può riportare ai valori di partenza.',
    workflowStep: 'filters'
  },
  {
    target: 'step-objects',
    title: 'Gli oggetti inquadrati',
    text:
      'StarLight confronta il nome dell’oggetto e le coordinate scritte nel file con i cataloghi, e ti indica che cosa hai ripreso, con la dimensione apparente, la costellazione e una breve descrizione. Con la soluzione astrometrica, cioè la posizione esatta del campo nel cielo, segna gli oggetti sull’immagine: scegli quanti nomi mostrare (Essenziale, Normale o Ricca) e quali tipi nascondere. Se il file non ha la soluzione, Risolvi il campo la calcola con le stelle locali, se le hai installate, o con il catalogo Gaia in rete. Nella scheda Coordinate sull’immagine puoi aggiungere la griglia delle coordinate, l’orientamento e la barra di scala.',
    workflowStep: 'objects'
  },
  {
    target: 'step-export',
    title: 'L’esportazione',
    text:
      'Salvi l’immagine finita in PNG, JPEG, WebP, TIFF a sedici bit, BMP o FITS. Le regolazioni vengono riapplicate ai dati a piena risoluzione, non all’anteprima. Puoi ritagliare, scegliere un formato pronto, ingrandire con il metodo Contorni, che segue la direzione dei bordi, aggiungere una didascalia con i dati della ripresa e includere i marcatori degli oggetti e le coordinate.',
    workflowStep: 'export'
  },
  {
    target: 'menu-help',
    title: 'Il menu Aiuto',
    text:
      'Dal menu Aiuto apri la Guida, con la spiegazione di ogni strumento e le scorciatoie da tastiera; si apre anche con il tasto F1. Nello stesso menu trovi il Glossario dei termini dell’astrofotografia, questa guida rapida, il controllo degli aggiornamenti, il registro degli errori, la licenza, la pagina per sostenere StarLight e le informazioni sul programma.'
  }
]
