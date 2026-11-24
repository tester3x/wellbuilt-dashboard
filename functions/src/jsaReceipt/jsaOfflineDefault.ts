// Canonical built-in JSA content, mirrored from JSA/constants/jsaTemplate.ts.
export const offlineDefaultAssessment = {
  "name": "WellBuilt Loading JSA",
  "steps": [
    {
      "id": "driving-on-location",
      "title": "Driving on location",
      "items": [
        {
          "hazard": "Moving equipment, stationary equipment, personnel, flare, pressurized iron, wellheads, poor lighting/visibility, uneven ground, wet/soft ground, fire/explosion, triggering hazard.",
          "controls": "Maintain 5 MPH on location at all times, scan the area while moving forward, maintain a safe distance from potential hazards, identify wind direction, muster points, and emergency evacuation routes, and maintain eye contact with moving personnel."
        }
      ]
    },
    {
      "id": "backing",
      "title": "Backing",
      "items": [
        {
          "hazard": "Poor lighting/visibility, damage to equipment, personal injury.",
          "controls": "Use forward movement if possible, use spotters when available, maintain constant radio contact with spotters at all times, walk the area before backing to identify potential hazards, and mark with orange cones."
        }
      ]
    },
    {
      "id": "connecting-hoses",
      "title": "Connecting hoses",
      "items": [
        {
          "hazard": "Pressurized hoses, pinched fingers, poor connection, missing gaskets causing leaks, uneven/soft ground when moving hoses causing slips or falls, personal injury, static charge.",
          "controls": "Check for trapped pressure and point hoses in a safe direction before connecting hoses; wear appropriate gloves when connecting hoses; inspect hose, fittings, and gaskets before connection; scan the area while walking on surfaces; connect grounding to prevent static discharge."
        }
      ]
    },
    {
      "id": "loading-fluids",
      "title": "Loading fluids",
      "items": [
        {
          "hazard": "Overloading transport causes spills, personal exposure to fluids, and pinched fingers and hands while operating valves.",
          "controls": "Maintain valve control and visual levels at all times, continuously scan hoses, valves, and manifolds for leaks, wear gloves and PPE prior to loading, and use headlights and transport lighting as needed."
        }
      ]
    },
    {
      "id": "checking-levels",
      "title": "Checking levels on frac/production tanks",
      "items": [
        {
          "hazard": "Personal injury, slips, and trips when ascending and descending ladder, gases/fumes rising from the tank.",
          "controls": "Maintain three points of contact when ascending and descending ladders, wear four gas monitors at all times to identify gases/fumes, and use appropriate measurement tools to ensure accurate levels."
        }
      ]
    },
    {
      "id": "offloading-fluids",
      "title": "Offloading fluids",
      "items": [
        {
          "hazard": "Overloading tanks can cause spills, personal exposure to fluids, overpressure of the vacuum tank, and pinched fingers while operating valves.",
          "controls": "Maintain valve control and visual levels at all times, continuously scan hoses, valves, and manifolds for leaks, wear gloves and PPE before loading, use headlights and transport lighting as needed."
        }
      ]
    },
    {
      "id": "disconnecting-hoses",
      "title": "Disconnecting hoses",
      "items": [
        {
          "hazard": "Pressurized hoses, spills, pinched fingers/hands, static charge.",
          "controls": "Verify valves are closed and hoses are depressurized before disconnecting, watch hand placement, and place buckets under connections to mitigate spills."
        }
      ]
    },
    {
      "id": "spill-cleanup",
      "title": "Spill clean-up",
      "items": [
        {
          "hazard": "Working around overhead loads can cause injury, as can energized equipment, high-pressure iron causing damage to equipment and personal injury, and unknown fluids.",
          "controls": "Understand overhead load fall radius, use caution while working around equipment, find and gauge high-pressure lines and mark and not run over them, question fluids being cleaned up, and maintain communication with employer in charge of equipment."
        }
      ]
    },
    {
      "id": "verify-complete",
      "title": "Verify task is complete, job clean-up",
      "items": [
        {
          "hazard": "Slips, trips, falls while putting up equipment, leaving equipment or misplacing it while cleaning up, failing to ensure all job tasks are complete, causing poor work, and personal injury.",
          "controls": "Utilize appropriate lighting, scan area for hoses and uneven ground, watch footing, walk around equipment to ensure everything is stored for transport, and speak with the pusher or facilities operator to ensure all tasks are complete."
        }
      ]
    }
  ],
  "ppeItems": [
    {
      "id": "safetyGlasses",
      "label": "Safety Glasses"
    },
    {
      "id": "safetyShoes",
      "label": "Safety Shoes"
    },
    {
      "id": "frClothing",
      "label": "FR Clothing"
    },
    {
      "id": "hearingProtection",
      "label": "Hearing Protection"
    },
    {
      "id": "hardHat",
      "label": "Hard Hat"
    },
    {
      "id": "respirator",
      "label": "Respirator"
    },
    {
      "id": "chemicalGloves",
      "label": "Chemical/Impact Gloves"
    },
    {
      "id": "fourGasMonitor",
      "label": "Four Gas Monitor"
    },
    {
      "id": "fallProtection",
      "label": "Fall Protection"
    },
    {
      "id": "other1",
      "label": "Other"
    },
    {
      "id": "other2",
      "label": "Other"
    },
    {
      "id": "other3",
      "label": "Other"
    },
    {
      "id": "other4",
      "label": "Other"
    }
  ],
  "preparedItems": [
    {
      "id": "trained",
      "label": "I am properly trained for the job"
    },
    {
      "id": "toolsAndPpe",
      "label": "I have the tools & PPE needed for work"
    },
    {
      "id": "sds",
      "label": "SDS"
    }
  ]
} as const;
