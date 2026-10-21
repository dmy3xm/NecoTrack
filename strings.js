// ── ALL UI TEXT — edit Ukrainian here ──
const T = {
  // auth
  tagline: 'твоє аніме — твої правила',
  authTitle: 'Увійти через AniList',
  authDesc: 'Підключи свій AniList акаунт, щоб завантажити та синхронізувати список. Токен зберігається лише у цьому браузері.',
  authOAuth: 'Продовжити через AniList',
  authDivider: 'або вставити токен вручну',
  tokenLabel: 'Токен доступу',
  tokenPlaceholder: 'вставте токен сюди…',
  authLogin: 'Увійти',
  enterToken: 'Please enter a token',
  // header / tabs / controls
  logout: 'Вийти', tabAll: 'Усі', home: 'На головну',
  searchPlaceholder: 'Пошук у списку…',
  sortTitle: 'За назвою', sortScore: 'За оцінкою', sortProgress: 'За прогресом',
  sortUpdated: 'За датою', sortYear: 'За роком', groupOn: 'Групи', groupOff: 'Список',
  // edit modal
  fldStatus: 'Статус', fldScore: 'Оцінка', fldProgress: 'Прогрес', fldNotes: 'Нотатки',
  notesPlaceholder: 'Твої особисті нотатки…', epShort: 'еп',
  delete: '🗑 Видалити', cancel: 'Скасувати', save: 'Зберегти', close: 'Закрити',
  // list / stats / rows
  empty: 'Тут ще нічого немає', emptyAlt: 'Порожньо',
  statAnime: 'аніме', statAvg: 'сер. оцінка', statEpisodes: 'переглянуто епізодів',
  seasons: 'entries', plusEpisode: '+1 episode', loading: 'Завантаження…',
  // info modal
  related: 'Пов\'язані', inList: 'У списку', showMore: 'Показати більше', showLess: 'Згорнути',
  descEn: 'Англійською', descUa: 'Українською',
  anilistLink: 'Відкрити на AniList ↗',
  tolokaLink: 'Шукати на Толоці ↗', addPrompt: 'Додати до списку:', edit: 'Редагувати', addedToList: 'Додано',
  communityScore: 'Спільнота', myScore: 'Моя оцінка',
  // sequel suggestion
  sequelTitle: 'Є продовження!',
  sequelDesc: title => `Ви завершили «${title}». Додати продовження до планів?`,
  sequelAdd: '+ До планів',
  sequelAdded: 'Додано до планів',
  sequelNo: 'Не зараз',
  sequelAnd: 'також',
  // top (global AniList ranking)
  tabTop: 'Топ',
  topAllYears: 'Всі роки',
  topAllTime: 'за весь час',
  topHeading: label => `Топ ${label}`,
  topSearchPh: 'Пошук на AniList…',
  topMore: 'Показати ще',
  topSearching: 'Шукаю…',
  topOtherYear: y => y ? `не з цього року · ${y}` : 'рік невідомий',
  topFindTitle: 'Немає в цьому рейтингу',
  topFindOtherYear: (y, cur) => y
    ? `Це реліз ${y} року, тому в рейтингу за ${cur} його немає. Оберіть ${y} у смужці років угорі.`
    : `Рік виходу невідомий, тому в рейтингу за ${cur} цього тайтла немає.`,
  topFindUnranked: 'Рейтинг переглянуто до кінця — цей тайтл до нього не входить, бо не має оцінки.',
  topFindDeeper: n => `Немає серед перших ${n} рейтингу.`,
  topFindMore: n => `Шукати ще ${n}`,
  topFindGoToYear: y => `Шукати в ${y}`,
  topFindInfo: 'Про аніме',
  // trailer
  trailer: 'Трейлер',
  trailerOfficial: 'Офіційний трейлер',
  trailerYouTube: 'YouTube ↗',
  trailerFullscreen: 'На весь екран',
  sequelInfo: 'Детальніше',
  // catalog search
  searching: 'Searching…', nothingFound: 'Nothing found',
  catalogResults: 'AniList catalog results', catalogInList: 'In list', catalogAdd: '+ Add',
  // toasts / messages (parameterized ones are functions)
  added: 'Added to planning', saved: 'Saved ✓', deleted: 'Видалено зі списку',
  completed: 'Completed! 🎉', loadFailed: 'Не вдалося завантажити: ', errPrefix: 'Помилка: ',
  errAnilistDown: 'AniList лежить',
  errOffline: 'Немає з\'єднання з інтернетом.',
  retry: 'Спробувати ще',
  confirmDelete: title => `Видалити «${title}» зі списку? Цю дію не можна скасувати.`,
  toastProgress: (p, eps) => `${p}${eps ? '/'+eps : ''} episodes`,
  // dates
  locale: 'uk-UA',
  dateUnknown: 'Дата невідома',
  // ukrainian dub (AniHub)
  dubTitle: 'Українська озвучка',
  dubYes: 'Є українська озвучка',
  dubNone: 'Української озвучки немає',
  dubMore: n => `ще ${n}`,
  dubCount: n => `${n} ${n === 1 ? 'команда' : 'команд'}`,
  dubMerged: n => `злито ${n}`,
  dubMergedHint: 'AniHub тримає одну команду під кількома записами',
  // studio
  studio: 'Студія', studios: 'Студії',
  studioWorks: 'Аніме студії',
  studioAnilist: 'Студія на AniList ↗',
  studioCount: n => `${n} тайтлів`,
  studioNone: 'Тайтлів не знайдено',
  // plain-text export (avatar menu)
  exportTitle: 'Експорт списку',
  exportDesc: 'Список простим текстом — для себе, друга чи ШІ',
  exportCopy: 'Копіювати',
  exportDownload: '.txt',
  exportPdf: 'PDF',
  exportPdfPreparing: 'Готую PDF…',
  pdfPreview: 'Попередній перегляд',
  pdfSave: 'Зберегти PDF',
  printTitle: name => `Аніме-список ${name}`,
  exportCopied: 'Список скопійовано ✓',
  exportFailed: 'Не вдалося скопіювати',
  exportHeader: (name, date, n) => `NecoTrack · список аніме ${name} · ${date} · ${n} аніме`,
  exportScore: 'оцінка',
  exportRepeating: 'Передивляюсь',   // not in `status`: that map also drives the add-to-list buttons
  // enum → label maps (used by both HTML data-i18n and JS)
  status:      { CURRENT:'Дивлюсь', COMPLETED:'Переглянуто', PLANNING:'Планую', PAUSED:'Призупинено', DROPPED:'Закинуто' },
  relation:    { SEQUEL:'Сіквел', PREQUEL:'Приквел', SPIN_OFF:'Спін-оф', SIDE_STORY:'Побічна історія',
                 ALTERNATIVE:'Альтернатива', SUMMARY:'Підсумок', PARENT:'Батьківський', CHARACTER:'Персонаж', OTHER:'Інше' },
  mediaStatus: { FINISHED:'Завершено', RELEASING:'Виходить', NOT_YET_RELEASED:'Очікується', CANCELLED:'Скасовано', HIATUS:'Пауза' },
  mediaStatusShort: 'Скоро',   // thumbnails: «Очікується» cannot fit one line
  format:      { TV:'TV', TV_SHORT:'TV Short', MOVIE:'Фільм', SPECIAL:'Спешл', OVA:'OVA', ONA:'ONA', MUSIC:'Музика' },
};
