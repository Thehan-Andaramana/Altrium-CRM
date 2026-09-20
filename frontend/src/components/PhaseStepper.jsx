// Where a project has got to, as a row of connected dots.
//
// Green behind you, amber where you are, grey ahead -- the same reading as
// the phase cards, compressed to something you can take in at a glance from
// the top of the lead.
//
// Deliberately not interactive: a phase only moves on an approved sign-off,
// so a clickable step would imply a shortcut that doesn't exist (the board
// makes the same point by refusing a cross-column drag).

const PHASES = [
  { number: 1, label: 'Requirements' },
  { number: 2, label: 'Analysis' },
  { number: 3, label: 'Execution' },
  { number: 4, label: 'Sign-Off' },
]

function stateFor(project, phase) {
  if (project.maintenance) {
    return 'complete'
  }
  const status = project[`phase_${phase}_status`]
  if (status === 'COMPLETE') {
    return 'complete'
  }
  if (status === 'NOT_STARTED') {
    return 'upcoming'
  }
  // IN_PROGRESS or AWAITING_APPROVAL -- both are "you are here".
  return 'current'
}

const STATE_LABELS = {
  complete: 'complete',
  current: 'in progress',
  upcoming: 'not started',
}

export default function PhaseStepper({ project }) {
  if (!project) {
    return null
  }

  const steps = PHASES.map((phase) => ({ ...phase, state: stateFor(project, phase.number) }))
  const maintenanceState = project.maintenance ? 'current' : 'upcoming'

  return (
    <ol className="stepper" aria-label="Phase progress">
      {steps.map((step, index) => (
        <li key={step.number} className={`stepper__step stepper__step--${step.state}`}>
          {index > 0 && <span className="stepper__line" aria-hidden="true" />}
          <span className="stepper__dot" aria-hidden="true" />
          <span className="stepper__label">
            <span className="stepper__phase">Phase {step.number}</span>
            <span className="stepper__name">{step.label}</span>
          </span>
          {/* The colour alone carries the state visually; this says it in
              words for anyone who can't use the colour. */}
          <span className="visually-hidden">{STATE_LABELS[step.state]}</span>
        </li>
      ))}
      <li className={`stepper__step stepper__step--${maintenanceState}`}>
        <span className="stepper__line" aria-hidden="true" />
        <span className="stepper__dot" aria-hidden="true" />
        <span className="stepper__label">
          <span className="stepper__phase">After</span>
          <span className="stepper__name">Maintenance</span>
        </span>
        <span className="visually-hidden">{STATE_LABELS[maintenanceState]}</span>
      </li>
    </ol>
  )
}
