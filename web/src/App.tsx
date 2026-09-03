import { Link, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { About } from './pages/About';
import { Home } from './pages/Home';
import { Podcast } from './pages/Podcast';
import { Settings } from './pages/Settings';
import { StoryDetail } from './pages/StoryDetail';

function NotFound() {
  return (
    <div className="container max-w-3xl py-24 text-center">
      <h1 className="font-display text-4xl mb-3">Oops! Page not found</h1>
      <p className="text-muted-foreground mb-5">
        That page doesn't exist. Try today's news, the podcast, or the about page.
      </p>
      <Link to="/" className="font-semibold text-primary underline hover:text-primary/90">
        Return to Home
      </Link>
    </div>
  );
}

/** The five public routes of PRD §3.1. Admin routes (§4.1) are out of scope. */
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="story/:id" element={<StoryDetail />} />
        <Route path="podcast" element={<Podcast />} />
        <Route path="about" element={<About />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
