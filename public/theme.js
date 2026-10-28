// Applies the visitor's saved light/dark choice before the page paints, so it never flashes the other theme.
try{const theme=localStorage.getItem('pg-theme');if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme;}catch{ /* Storage blocked: keep the default dark theme. */ }
