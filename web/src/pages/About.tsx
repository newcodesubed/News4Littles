import type { ReactNode } from 'react';
import { GraduationCap, Heart, ShieldCheck, Sparkles } from 'lucide-react';

/** About — PRD §3.7, copy and layout matching the prototype. */
function Pillar({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="bg-card rounded-3xl p-6 border border-border shadow-soft">
      <span className="w-10 h-10 rounded-2xl bg-primary/10 text-primary grid place-items-center mb-3">
        {icon}
      </span>
      <h3 className="font-display text-xl mb-1.5">{title}</h3>
      <p className="text-sm text-foreground/75 leading-relaxed">{children}</p>
    </div>
  );
}

export function About() {
  return (
    <div>
      <section className="bg-gradient-hero">
        <div className="container max-w-3xl py-16 text-center">
          <h1 className="font-display text-5xl md:text-6xl leading-tight mb-5">
            A kinder way for kids to <span className="text-primary">meet the world</span>.
          </h1>
          <p className="text-lg text-foreground/75">
            News and current world affairs can be delivered in an age-friendly manner — no matter how
            difficult or desolate the situation. Kids who want to learn about the world should be
            able to do so safely, clearly, and without fear.
          </p>
        </div>
      </section>

      <div className="container max-w-3xl py-14 space-y-12">
        <section>
          <h2 className="font-display text-3xl mb-3">Our mission</h2>
          <p className="text-lg text-foreground/80 leading-relaxed">
            We make complex news easy to understand, emotionally safe, factual, and
            curiosity-building. We believe children grow into thoughtful, hopeful citizens when they
            are trusted with the truth — told gently, at the right level, with the help of caring
            grown-ups.
          </p>
        </section>

        <section className="grid sm:grid-cols-2 gap-4">
          <Pillar icon={<ShieldCheck />} title="Emotionally safe">
            We avoid graphic detail, sensational language, and frightening images. When stories are
            heavy, we add a gentle feeling note and flag where adult guidance helps.
          </Pillar>
          <Pillar icon={<Sparkles />} title="Curiosity-building">
            Every story ends with a question. We name new words, give clear definitions, and invite
            kids to wonder out loud with the people they trust.
          </Pillar>
          <Pillar icon={<Heart />} title="Factual &amp; grounded">
            We ground every simplified story in a reputable source — BBC, Reuters, AP, NPR — and
            never invent details. We don't present opinion as fact.
          </Pillar>
          <Pillar icon={<GraduationCap />} title="For families &amp; schools">
            Parents, teachers, and editors can submit articles or review the daily curation. The
            reading age is adjustable from 5 to 14 — defaulting to 6.
          </Pillar>
        </section>

        <section className="bg-card rounded-3xl border border-border p-6 md:p-8 shadow-soft">
          <h2 className="font-display text-2xl mb-3">Editorial guardrails</h2>
          <ul className="space-y-2 text-foreground/80">
            <li>• Avoid graphic details, gore, or unnecessary traumatic detail.</li>
            <li>
              • For difficult topics: explain what happened, who is helping, and what kids can do
              with a trusted adult.
            </li>
            <li>• Flag adult-context stories: war, disasters, violence, death, political conflict.</li>
            <li>• Explain uncertainty honestly. Avoid sensational language.</li>
            <li>• Never present political persuasion as fact.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
