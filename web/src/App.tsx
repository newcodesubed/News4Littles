import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { EmptyState } from './components/States';
import { About } from './pages/About';
import { Home } from './pages/Home';
import { Podcast } from './pages/Podcast';
import { Settings } from './pages/Settings';
import { StoryDetail } from './pages/StoryDetail';

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
        <Route
          path="*"
          element={
            <EmptyState title="That page doesn’t exist">
              Try today’s news, the podcast, or the about page from the menu above.
            </EmptyState>
          }
        />
      </Route>
    </Routes>
  );
}
