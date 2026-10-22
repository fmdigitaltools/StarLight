/**
 * Help center content in Italian (reference language).
 *
 * `helpContent.en.ts` holds the same entries, in the same order, in English.
 * Texts may contain `{name}` placeholders that HelpCenter fills when rendering:
 * `{objectCount}` (number of objects in the bundled catalog), `{cropKey}`,
 * `{compareKey}` and `{shortcutListKey}` (keyboard shortcuts), `{count}`
 * (number of glossary entries).
 */

/** Icon shown next to a help entry; HelpCenter maps each name to its icon component. */
export type HelpIconName =
  | 'process'
  | 'folder'
  | 'import'
  | 'calibrate'
  | 'align'
  | 'eye'
  | 'wand'
  | 'correct'
  | 'filters'
  | 'objects'
  | 'export'
  | 'crop'
  | 'straighten'
  | 'restart'
  | 'info'
  | 'star'

export interface HelpEntry {
  icon: HelpIconName
  title: string
  text: string
}

export interface HelpContent {
  /** One entry per tool or area of the program. */
  tools: HelpEntry[]
  /** Introduction to the keyboard shortcut list. */
  shortcutsIntro: string
  /** Introduction to the glossary, followed by the links to `initialEntries`. */
  glossaryIntro: string
  /** Glossary entries suggested as a starting point; names must match the glossary terms in the same language. */
  initialEntries: string[]
}

export const HELP_CONTENT_IT: HelpContent = {
  tools: [
    {
      icon: 'process',
      title: 'La barra dei menu',
      text:
        'La prima riga in alto contiene sei menu. File raccoglie i comandi dei progetti, con la voce Progetti recenti che elenca gli ultimi cinque da riaprire con un clic, l’importazione dei frame, l’elaborazione in serie e l’esportazione dell’immagine. Modifica contiene Annulla, Ripeti e la cronologia delle modifiche. Visualizza regola l’ingrandimento e mostra o nasconde i marcatori degli oggetti, le stelle rilevate e il pannello degli strumenti. Plugin apre direttamente la galleria dei plugin. Impostazioni apre la finestra delle preferenze. Aiuto contiene la guida rapida, questa guida, il glossario dei termini tecnici, il controllo degli aggiornamenti, il registro degli errori, l’elenco delle scorciatoie da tastiera, la licenza con i riconoscimenti, la pagina per sostenere StarLight e le informazioni sul programma. Con la tastiera, le frecce scorrono le voci e passano da un menu all’altro, il tasto Invio esegue la voce scelta e il tasto Esc chiude il menu.'
    },
    {
      icon: 'folder',
      title: 'Progetti',
      text:
        'Un progetto conserva il lavoro svolto su un’immagine e ne permette la ripresa in un secondo momento. Ogni progetto è una cartella con il nome scelto, che contiene il file project.slight con le regolazioni e l’immagine elaborata. I frame originali non vengono copiati e restano nella loro posizione. Il menu File contiene i comandi Nuovo progetto, Apri progetto, Salva, Salva con nome e Chiudi progetto. La chiusura svuota la libreria e riporta il programma allo stato iniziale.'
    },
    {
      icon: 'import',
      title: 'Importa',
      text:
        'Il pulsante Importa frame carica singoli file. StarLight accetta i file FITS, il formato usato in astronomia per le immagini e i dati di scatto, i file XISF, le immagini TIFF e PNG e i formati RAW delle fotocamere. Il pulsante Cartella carica tutti i file FITS, XISF e RAW di una cartella. StarLight riconosce i frame grezzi, i frame di calibrazione e i file già impilati dal telescopio, cioè già sommati fra loro. All’importazione viene letta soltanto l’intestazione dei file, la parte che contiene i dati di scatto, quindi anche centinaia di file vengono caricati in pochi istanti. Nella libreria, un clic su un frame lo apre nel visore e il pulsante con l’occhio lo esclude dall’elaborazione senza rimuoverlo.'
    },
    {
      icon: 'calibrate',
      title: 'Calibrazione',
      text:
        'I master, cioè i frame di riferimento usati per la correzione, vengono costruiti dai frame di calibrazione presenti in libreria combinandoli con la mediana, il valore centrale fra tutti quelli misurati per ciascun pixel. I frame ripresi in condizioni diverse (posa, guadagno, temperatura, filtro, notte) vengono divisi automaticamente in gruppi, con un master per gruppo, e ogni scatto del cielo usa quello con le sue condizioni. Alcuni telescopi registrano già il master dark, che basta importare come un file qualsiasi. Prima della somma i master vengono applicati agli scatti del cielo, con l’eliminazione del segnale prodotto dal calore del sensore, dei pixel difettosi e delle ombre della polvere sull’ottica.'
    },
    {
      icon: 'align',
      title: 'Allineamento e impilamento',
      text:
        'Le stelle di ogni frame vengono confrontate con quelle del frame migliore per mezzo di triangoli, che conservano la stessa forma anche quando l’immagine è spostata o ruotata. I frame con un punteggio inferiore alla qualità minima vengono esclusi. Il metodo Robusto calcola la media dei valori vicini alla mediana ed elimina le tracce dei satelliti e i raggi cosmici. Il metodo Media usa tutto il segnale, il metodo Mediana usa il valore centrale di ciascun pixel. Il calcolo viene diviso fra i nuclei del processore.'
    },
    {
      icon: 'align',
      title: 'Drizzle',
      text:
        'Fra uno scatto e l’altro il campo si sposta di frazioni di pixel. Il drizzle, nel passo Impila, sfrutta questi piccoli spostamenti e somma i frame su una griglia con il doppio dei pixel per lato e recupera dettaglio effettivamente registrato dal sensore. Il cursore Dimensione della goccia regola la parte di ogni pixel depositata sulla nuova griglia. Il drizzle richiede l’allineamento attivo e rende di più con almeno una ventina di frame. Il risultato ha quattro volte i pixel e richiede più memoria e più tempo.'
    },
    {
      icon: 'align',
      title: 'Comete',
      text:
        'Durante la ripresa una cometa si sposta fra le stelle, e la scheda Cometa del passo Impila stabilisce che cosa resta fermo nel risultato. Con Stelle ferme l’impilamento è quello normale e la cometa esce allungata. Con Cometa ferma i frame vengono allineati sul nucleo: la cometa è nitida e le stelle diventano strisce, in gran parte tolte dallo scarto delle code. Con Tutte e due il programma ricava la sola cometa dalla somma allineata sul nucleo, la toglie da ogni frame, somma i frame sulle stelle e alla fine rimette sopra la cometa, con stelle puntiformi e cometa nitida. Il nucleo viene cercato in automatico come il punto luminoso esteso che si sposta a velocità costante, usando l’ora di scatto scritta nei file; in alternativa lo si indica con un clic sul primo e sull’ultimo frame, il modo più sicuro con comete deboli o lente. Il drizzle si applica solo con Cometa ferma.'
    },
    {
      icon: 'eye',
      title: 'Sessione dal vivo',
      text:
        'La sessione dal vivo, nel passo Impila, sorveglia la cartella in cui il programma di ripresa salva i frame, anche se si tratta di una cartella di rete condivisa dal telescopio. Ogni frame nuovo viene analizzato e allineato, poi l’impilamento viene ricalcolato e l’immagine nel visore si aggiorna durante la ripresa. L’interruttore Includi i frame già presenti aggiunge anche i frame salvati prima dell’avvio. La cartella proposta si imposta nelle Impostazioni, alla scheda Telescopio.'
    },
    {
      icon: 'align',
      title: 'Mosaico',
      text:
        'Il mosaico, nel passo Impila, unisce più inquadrature di zone vicine del cielo, dette pannelli, in un campo più ampio. Ogni pannello viene collocato con la propria soluzione astrometrica, letta dal file oppure calcolata con il comando Risolvi il campo del passo Oggetti. Il fondo cielo e la luminosità vengono pareggiati nelle zone in comune e i bordi vengono fusi senza linee di giunzione. La sovrapposizione consigliata fra i pannelli è del 10-20%.'
    },
    {
      icon: 'wand',
      title: 'Abracadabra',
      text:
        'Il pulsante Abracadabra, nella barra superiore, prepara l’immagine in modo automatico. Il programma misura l’immagine, regola gli strumenti del passo Elabora, esegue il calcolo e imposta nel passo Correggi la distensione iperbolica generalizzata (GHS) e la saturazione. Propone inoltre il ritaglio dei bordi rumorosi, che si vede e si cambia con il pulsante Ritaglio, e un avviso finale riassume le correzioni eseguite. I valori scelti restano modificabili nei passi Elabora e Correggi, e il pulsante Ripristina riporta l’immagine all’originale.'
    },
    {
      icon: 'process',
      title: 'Elabora',
      text:
        'Il passo Elabora raccoglie gli strumenti che trasformano i dati prima della distensione, cioè quando l’immagine è ancora lineare. Ogni scheda ha regolazioni proprie. Il calcolo parte con il pulsante Applica presente in fondo a ogni scheda, oppure con Applica tutto in fondo alla colonna: in entrambi i casi il calcolo comprende tutti gli strumenti, richiede qualche secondo e riparte sempre dall’immagine originale. L’etichetta «da applicare» segnala la scheda con valori modificati e non ancora calcolati. Gli strumenti vengono eseguiti in un ordine fisso, stabilito dal programma, e il pulsante Reset li riporta tutti ai valori iniziali.'
    },
    {
      icon: 'process',
      title: 'Difetti e fondo cielo',
      text:
        'La scheda corregge i pixel difettosi, cioè i punti isolati molto più luminosi dei vicini, e li sostituisce con la mediana dei pixel attorno. Estrae poi il fondo cielo, la luce diffusa dall’inquinamento luminoso e dalla Luna. Il modo Semplice descrive il fondo con una superficie morbida, adatta alle variazioni graduali. Il modo Avanzato usa funzioni a base radiale e segue anche aloni e variazioni irregolari, con tre cursori per il numero di campioni, la levigatezza e la tolleranza.'
    },
    {
      icon: 'process',
      title: 'Scie di satelliti',
      text:
        'Aerei e satelliti che passano nel campo durante la posa lasciano una riga luminosa. L’interruttore Togli le scie individua queste righe, anche quando si interrompono a metà immagine o sono fatte di trattini, e ricostruisce i loro pixel con il cielo e la grana dei due lati, solo nel tratto in cui la riga è presente. Una riga viene considerata una scia solo se è dritta, molto lunga e larga quanto una stella per tutto il suo percorso: una galassia vista di taglio è più larga e si assottiglia alle estremità, il filamento di una nebulosa si piega e cambia luminosità. Con la soluzione astrometrica restano escluse anche le galassie e le nebulose del catalogo. Il cursore Sensibilità regola il rilevamento delle scie deboli. Sulle immagini impilate lo strumento di solito non serve, perché l’impilamento scarta già le scie.'
    },
    {
      icon: 'process',
      title: 'Colore',
      text:
        'Il bilanciamento Sulle stelle rende bianco il colore medio delle stelle. Il bilanciamento Fotometrico confronta le stelle dell’immagine con il catalogo Gaia, che ne riporta il colore misurato, e il pulsante Calcola da Gaia ricava la correzione di ciascun canale. È il metodo più preciso, ma richiede la connessione a internet e la soluzione astrometrica del campo. Il cursore Grana colorata elimina le macchie di colore dal fondo cielo e uniforma il colore di ogni stella, senza modifiche alla nitidezza.'
    },
    {
      icon: 'process',
      title: 'Deconvoluzione',
      text:
        'La deconvoluzione recupera la nitidezza attenuata dalla turbolenza dell’aria e dall’ottica, a partire dalla forma misurata delle stelle. Il metodo usato è quello di Richardson-Lucy. Il cursore Iterazioni definisce il numero di ripetizioni del calcolo, e oltre un certo valore compaiono aloni e grana. Con il cursore Ampiezza della sfocatura a zero, l’ampiezza viene misurata sulle stelle dell’immagine. La regolarizzazione limita l’amplificazione del rumore. Lo strumento non aggiunge dettagli, ma ripristina quelli attenuati.'
    },
    {
      icon: 'process',
      title: 'Riduzione del rumore',
      text:
        'NL-Bayes confronta ogni piccola zona dell’immagine con le zone simili e ne conserva la struttura comune, con l’eliminazione della grana. Le ondine scompongono l’immagine in cinque scale, da 1 a 16 pixel, e un cursore per ciascuna scala regola la riduzione del rumore a quella dimensione. Le ondine sono utili sulla grana a grumi di qualche pixel, che NL-Bayes lascia in parte.'
    },
    {
      icon: 'process',
      title: 'Dettagli per scala',
      text:
        'Cinque cursori, uno per ogni scala da 1 a 16 pixel, rinforzano o attenuano i dettagli della dimensione corrispondente. Le scale piccole corrispondono alla grana e ai filamenti sottili, quelle grandi ai bracci delle galassie e alle nubi. La scomposizione è la stessa delle ondine usate per la riduzione del rumore.'
    },
    {
      icon: 'process',
      title: 'Banda stretta',
      text:
        'Con un filtro a doppia banda il sensore a colori raccoglie due sole righe di luce, l’idrogeno (H-alfa) nel rosso e l’ossigeno (OIII) nel verde e nel blu. La scheda separa le due righe e le ricompone secondo le tavolozze della fotografia in banda stretta. HOO assegna l’idrogeno al rosso e l’ossigeno al verde e al blu. Foraxx aggiunge passaggi dorati nelle zone in cui i due gas sono entrambi intensi. Hubble sintetica imita l’oro e il blu delle immagini del telescopio spaziale, ma senza lo zolfo, che questo filtro non raccoglie. I cursori regolano l’equilibrio fra i due gas e l’intensità dell’ossigeno. I colori ottenuti sono una convenzione e non corrispondono alla visione dell’occhio.'
    },
    {
      icon: 'process',
      title: 'Riduzione delle stelle',
      text:
        'Lo strumento rimpicciolisce le stelle e riempie lo spazio liberato con il fondo circostante, a vantaggio di nebulose e galassie. Il cursore Dimensione regola il rimpicciolimento, il cursore Luminosità l’attenuazione della luce delle stelle. Il calcolo non usa reti neurali.'
    },
    {
      icon: 'process',
      title: 'Contrasto locale',
      text:
        'Il contrasto locale fa risaltare le strutture interne di galassie e nebulose con una regolazione del contrasto zona per zona, secondo il metodo CLAHE. Il cursore Forza regola l’effetto, il cursore Limite definisce il contrasto massimo di ogni zona e il cursore Zone per lato il numero delle zone. Un numero maggiore di zone segue strutture più piccole. L’effetto va dosato con moderazione, perché accentua anche il rumore.'
    },
    {
      icon: 'process',
      title: 'Plugin',
      text:
        'I plugin sono strumenti aggiuntivi gratuiti e open source, cioè con il codice pubblico. La galleria, dal menu Plugin, contiene quelli inclusi in StarLight, che aumentano con le nuove versioni del programma: si attivano e si disattivano, e la scelta resta anche alle aperture successive. La galleria funziona anche senza internet, e le schede Tutti e Attivi mostrano insieme plugin e cataloghi deep sky. Un plugin personale o di un altro sviluppatore si installa in locale, da una cartella o da un archivio ZIP sul computer: il server di StarLight ospita solo i pacchetti di FM Digital Tools. I plugin attivi o installati compaiono nella scheda Strumenti aggiuntivi del passo Elabora e vengono applicati dopo tutti gli altri strumenti, nell’ordine di accensione. Ogni plugin lavora isolato dal resto del programma, senza accesso ai file né a internet.'
    },
    {
      icon: 'correct',
      title: 'Distensione',
      text:
        'La distensione schiarisce i toni deboli di un frame lineare e rende visibile l’oggetto. Il punto di nero taglia il rumore di fondo, i mezzitoni regolano l’emersione del segnale debole e il punto di bianco definisce il livello del bianco pieno. In alternativa ai mezzitoni, la distensione iperbolica generalizzata (GHS) concentra il contrasto su una fascia di luminosità scelta, con cursori per la forza, l’intensità locale, il punto di simmetria e la protezione delle ombre e delle luci. Il pulsante Auto calcola il punto di nero e i mezzitoni dal fondo cielo, con tre livelli di intensità.'
    },
    {
      icon: 'correct',
      title: 'Curve',
      text:
        'La curva lega il tono di un pixel prima della correzione al tono dopo la correzione. La linea diagonale lascia l’immagine invariata, una linea più alta la schiarisce. Un clic aggiunge un punto, il trascinamento lo sposta e il tasto destro lo rimuove. La scelta di un singolo canale di colore permette di correggere le dominanti che i tre cursori Guadagno non risolvono.'
    },
    {
      icon: 'correct',
      title: 'Toni e colore',
      text:
        'Le schede Toni e Colore del passo Correggi regolano luminosità, contrasto, gamma e saturazione. La vividezza ravviva soprattutto i colori spenti e lascia quasi invariati quelli già intensi, quindi le nebulose prendono colore senza un eccesso sulle stelle colorate. I tre cursori Guadagno correggono la dominante di colore, per esempio il fondo verdastro lasciato dai filtri antinquinamento luminoso.'
    },
    {
      icon: 'correct',
      title: 'Regolazioni locali e maschere',
      text:
        'La scheda Regolazioni locali del passo Correggi applica una regolazione soltanto a una parte della foto, per esempio per schiarire le zone deboli di una nebulosa senza bruciarne il nucleo, o per ravvivare il rosso dell’idrogeno lasciando invariate le stelle. Ogni regolazione ha una maschera, che decide dove agisce, e i suoi cursori: luminosità, contrasto, saturazione, vividezza, temperatura, tinta, nitidezza e riduzione del rumore. Le maschere automatiche sono sei. Luce sceglie una fascia di luminosità. Colore sceglie una tinta, con scelte pronte per il rosso dell’idrogeno e l’azzurro dell’ossigeno. Stelle segue le stelle trovate nell’immagine, con un cerchio più grande per quelle più luminose. Oggetto disegna un’ellisse attorno all’oggetto riconosciuto nel campo. Sfumatura e Cerchio si tracciano trascinando sulla foto. Ogni maschera ha una sfumatura dei bordi, un’intensità e il comando Inverti la maschera, che per esempio con Stelle fa agire la regolazione su tutto tranne le stelle. Con il pennello e la gomma la zona si disegna a mano, direttamente sulla foto, da sola o per restringere una maschera automatica; la rotella e il tasto destro continuano a ingrandire e a spostare l’immagine. Il comando Mostra la maschera in rosso colora la zona in cui la regolazione agisce. Le regolazioni possono essere fino a quattro, si applicano dopo tutte le altre correzioni, finiscono anche nell’immagine esportata e si salvano nel progetto. Ogni pennellata è un passo della cronologia, quindi si annulla con Ctrl+Z.'
    },
    {
      icon: 'filters',
      title: 'Filtri',
      text:
        'Ventiquattro filtri fotografici modificano la resa dei colori, dal seppia al falso colore, e il cursore Intensità del filtro ne regola la forza. La riduzione del rumore calcola la media dei pixel vicini soltanto dove hanno luminosità simile e, con valori più alti, considera una zona più ampia e scioglie anche la grana a grumi. La nitidezza esalta i dettagli fini e la vignettatura scurisce gradualmente bordi e angoli. La rimozione del fondo sottrae da ogni canale di colore un livello costante, pari al fondo cielo misurato sull’immagine. Le variazioni del fondo da una zona all’altra si correggono invece nel passo Elabora.'
    },
    {
      icon: 'objects',
      title: 'Oggetti',
      text:
        'Il campo inquadrato viene confrontato con un catalogo di {objectCount} oggetti del cielo profondo, tratto da OpenNGC. StarLight indica l’oggetto principale e gli altri oggetti presenti nell’inquadratura, e con la soluzione astrometrica li segna sull’immagine con un cerchio e il nome. Quando il file non contiene la soluzione, il pulsante Risolvi il campo la calcola dal confronto fra le stelle della foto e quelle di un catalogo; servono, nell’intestazione del file, le coordinate di puntamento o il nome dell’oggetto. Con il pacchetto Stelle per la risoluzione del campo, scaricato dalla scheda Cataloghi deep sky della galleria dei plugin, il calcolo avviene senza internet e in pochi secondi. Senza il pacchetto, o nei campi stretti dove le sue stelle sono troppo poche, StarLight usa il catalogo Gaia in rete, se l’uso di internet è permesso. La richiesta può durare fino a un minuto. Con internet disattivato un avviso spiega il motivo e offre il pulsante Riattiva internet. Nella scheda Coordinate sull’immagine si accendono la griglia delle coordinate, l’orientamento con il nord e l’est e la barra di scala.'
    },
    {
      icon: 'export',
      title: 'Esporta',
      text:
        'Il passo Esporta offre sei formati di file, venticinque misure pronte per i social, per gli schermi e per la stampa, e un riquadro di ritaglio da trascinare per la scelta dell’inquadratura. Lo stesso riquadro si può spostare e ridimensionare anche sull’immagine grande, con il pulsante Ritaglio. TIFF e FITS conservano sedici bit per canale. Per l’ingrandimento oltre i pixel disponibili sono previsti due metodi. Lanczos è il filtro classico, nitido e fedele. Contorni segue la direzione dei bordi ed evita gradini e aloni attorno alle stelle. Nessuno dei due aggiunge dettagli assenti nei dati. Per PNG, JPEG e WebP l’opzione Includi i marcatori degli oggetti disegna cerchi e nomi nel file, e l’opzione Includi le coordinate aggiunge griglia, orientamento e barra di scala accesi nel passo Oggetti. Le correzioni vengono ricalcolate sui dati originali a piena risoluzione.'
    },
    {
      icon: 'crop',
      title: 'Ritaglio nel visore',
      text:
        'Il pulsante Ritaglio, nella barra in alto accanto ad Adatta, mostra nel visore la parte di immagine che verrà esportata: quella tolta appare scura. Il tasto {cropKey} fa lo stesso. Acceso, il riquadro si cambia direttamente sull’immagine in qualunque passo. Trascinandolo dall’interno lo si sposta, tirando gli angoli o i lati se ne cambia la misura. Se nel passo Esporta è scelta una proporzione o una misura pronta, il riquadro ne mantiene la forma. Fuori dal riquadro il mouse sposta l’immagine come sempre e la rotella la ingrandisce. Ogni trascinamento è un solo passo della cronologia, quindi Ctrl+Z lo annulla. Spento, il riquadro non si vede ma vale comunque per l’esportazione. Mentre si usano il pennello o la gomma delle maschere il riquadro resta visibile ma non si modifica.'
    },
    {
      icon: 'straighten',
      title: 'Ruotare, specchiare, raddrizzare',
      text:
        'Nella barra in alto, accanto alla Cronologia, i pulsanti ⟲ e ⟳ ruotano l’immagine di 90° e i due pulsanti Specchia la ribaltano da sinistra a destra o dall’alto in basso. Sono spostamenti di pixel, senza perdita di qualità. Il pulsante Raddrizza ruota di un angolo qualsiasi: con l’anteprima immediata, tracciando una linea da rendere orizzontale o verticale, oppure portando il nord in alto se c’è la soluzione astrometrica. Tutte queste operazioni valgono anche per l’esportazione, puoi annullarle con Indietro e vengono salvate nel progetto; marcatori degli oggetti, maschere, ritaglio e soluzione astrometrica seguono l’immagine.'
    },
    {
      icon: 'export',
      title: 'Elaborazione in serie',
      text:
        'Dal menu File, Elaborazione in serie applica la stessa ricetta a più immagini e salva un file per ciascuna. La ricetta comprende gli strumenti di Elabora, toni e colore, curve, filtro, inquadratura e formato del file. Si può prendere dall’immagine aperta con Usa le impostazioni dell’immagine aperta, salvare come file .recipe e riaprire in seguito. Con Abracadabra su ogni file ogni immagine viene misurata e preparata come con il pulsante Abracadabra: con immagini diverse fra loro è di solito la scelta migliore. Un ritaglio fisso ha senso solo per immagini con la stessa inquadratura, per questo è facoltativo. I file vanno nella cartella delle esportazioni, in una sottocartella con la data. Un file che esiste già non viene mai sovrascritto: al nuovo si aggiunge un numero. Durante la serie compaiono l’avanzamento e il tempo rimanente, e la serie si può interrompere. Alla fine un riepilogo elenca i file riusciti e il motivo di quelli non riusciti. L’immagine aperta, la cronologia e il progetto non vengono toccati.'
    },
    {
      icon: 'restart',
      title: 'Annulla, Ripeti e Cronologia',
      text:
        'Ogni modifica all’immagine diventa un passo della cronologia: regolazioni, curve, elaborazioni, Abracadabra, plugin, rotazioni, specchi e ritaglio. I pulsanti con le frecce nella barra in alto, il menu Modifica e i tasti Ctrl+Z e Ctrl+Y tornano indietro e avanti di un passo. Il pulsante Cronologia apre l’elenco dei passi: un clic su un passo riporta l’immagine a quel momento. Trascinare un cursore produce un solo passo. Aprire un altro frame o un progetto fa ripartire la cronologia.'
    },
    {
      icon: 'process',
      title: 'Impostazioni',
      text:
        'La finestra delle impostazioni si apre dal menu Impostazioni o con Ctrl e virgola, ed è divisa in cinque schede. Generale definisce la lingua, la cartella di lavoro per progetti, esportazioni e sessioni dal vivo, e la riapertura dell’ultimo progetto all’avvio. Prestazioni si apre con il riquadro delle impostazioni scelte per questo computer: al primo avvio StarLight misura processori, memoria e scheda grafica e sceglie da sé i valori, e il pulsante «Ottimizza per questo computer» rifà la scelta mostrando prima che cosa cambia. Sotto si regolano a mano il numero di thread per l’analisi dei frame, la memoria riservata ai frame aperti, la scheda grafica da usare (alte prestazioni o risparmio energetico) e l’accelerazione grafica, che valgono dal prossimo avvio e hanno il pulsante «Riavvia ora», e il calcolo a priorità bassa, che lascia il computer reattivo durante un impilamento lungo al costo di qualche secondo in più. In fondo, Spazio su disco mostra quanto occupa ciò che StarLight conserva da sé, con «Svuota» dove ha senso. Telescopio indica la cartella della sessione dal vivo. Rete e cataloghi permette o vieta l’uso di internet e fissa la magnitudine limite del catalogo Gaia. Aggiornamenti decide se cercare le versioni nuove all’avvio. In Generale si sceglie anche la lingua dei testi, italiano o inglese.'
    },
    {
      icon: 'info',
      title: 'Licenza e riconoscimenti',
      text:
        'StarLight è distribuito con licenza GNU GPL versione 3 o successiva. La licenza permette l’uso, lo studio, la modifica e la ridistribuzione del programma, che è fornito senza garanzia. La finestra Licenza e riconoscimenti, dal menu Aiuto, riporta il testo della licenza e l’elenco dei lavori di altri autori usati dal programma, come il catalogo OpenNGC, con le rispettive licenze.'
    },
    {
      icon: 'star',
      title: 'Sostieni StarLight',
      text:
        'StarLight è gratuito. La voce Sostieni StarLight del menu Aiuto, e il pulsante nella finestra Informazioni, aprono nel browser la pagina Ko-fi per una donazione a sostegno dello sviluppo.'
    },
    {
      icon: 'star',
      title: 'Scheda grafica e memoria',
      text:
        'Le correzioni dei passi Correggi e Filtri vengono calcolate dalla scheda grafica, che elabora tutti i pixel contemporaneamente, e per questo l’immagine cambia durante il movimento dei cursori. Gli strumenti del passo Elabora, più pesanti, vengono calcolati dal processore su tutti i nuclei disponibili. I frame già aperti restano in memoria, quindi la loro riapertura è immediata. La memoria occupata è indicata nella barra di stato alla voce RAM, e il limite si regola nelle Impostazioni, alla scheda Prestazioni.'
    }
  ],
  shortcutsIntro:
    'I comandi più usati hanno un tasto rapido, indicato anche a destra delle voci dei menu. Le lettere e i numeri da soli non valgono mentre si scrive in un campo di testo, e le frecce restano ai cursori. Tenendo premuto il tasto {compareKey} (la barra rovesciata, a sinistra dell’1 sulla tastiera italiana) si vede l’immagine com’era all’apertura, e lasciandolo si torna a quella lavorata. Lo stesso elenco, con una ricerca, si apre con {shortcutListKey} o dal menu Aiuto.',
  glossaryIntro:
    'Il significato dei termini tecnici è raccolto nella finestra Glossario, che si apre anche dal menu Aiuto: {count} voci, dalla ripresa all’esportazione, ciascuna con la definizione, il ruolo del dato in StarLight e i rimandi alle voci collegate, con una ricerca per nome, sigla o sinonimo. Alcune voci di partenza: ',
  initialEntries: ['Frame di luce', 'Master dark', 'Flat', 'Bias', 'Impilamento', 'Dati lineari', 'Distensione', 'Soluzione astrometrica']
}
