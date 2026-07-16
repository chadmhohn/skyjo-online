const rulesHelpSections = [
  {
    title: 'Starting a round',
    items: [
      'Everyone gets 12 face-down cards and chooses two opening cards to reveal.',
      'For the first round, the highest shown opening-card sum starts.',
      'After later rounds, the player who ended the previous round starts once opening cards are revealed.'
    ]
  },
  {
    title: 'Taking a turn',
    items: [
      'Take the top discard if you want that card, or draw blind from the deck.',
      'If you draw blind, either place it on your board or discard it and reveal one hidden card.'
    ]
  },
  {
    title: 'Clearing columns',
    items: ['Three matching values in one column clear that column. Cleared cards stop counting against you.']
  },
  {
    title: 'Ending and scoring',
    items: [
      'When someone reveals their last card, everyone else gets one final turn.',
      "If the closer's positive round score is not strictly lowest, that score doubles.",
      'The game ends when someone reaches 100 or more total points. Lowest total wins.'
    ]
  }
];

export default function RulesHelpPanel() {
  return (
    <section className="skyjo-settings-section">
      <div className="skyjo-settings-section-heading">
        <p className="skyjo-kicker">Help</p>
        <h3 className="skyjo-serif text-xl font-bold leading-tight text-[#f5e6c8]">Rules</h3>
      </div>
      <div className="skyjo-settings-rules-list">
        {rulesHelpSections.map((section) => (
          <section className="skyjo-rule-card rounded-xl border p-3" key={section.title}>
            <h4 className="skyjo-serif text-base font-bold leading-tight text-[#f5e6c8]">{section.title}</h4>
            <ul className="skyjo-rule-list mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6">
              {section.items.map((item) => (
                <li className="break-words" key={item}>
                  {item}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
