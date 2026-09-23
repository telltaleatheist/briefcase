/**
 * snap's live sanity cases, copied from /Volumes/Callisto/Projects/snap/tests/fixtures/
 * (10-yesno-sentiment, 20-choice-routing, 30-score-anger) and converted to this
 * port's array-shaped questions/options (option order = label order, as in the
 * fixture objects). Embedded as TS so they compile into dist with snap-smoke.
 * Checks: p_gt / p_lt (yesno p), choice_is, confidence_gt; across: score_increasing.
 */

import type { ScorerQuestion } from '../scorer.types';

export interface SanityExpect {
  q: string;
  check: 'p_gt' | 'p_lt' | 'choice_is' | 'confidence_gt';
  value: number | string;
}

export interface SanityRequest {
  id: string;
  state: unknown;
  questions: ScorerQuestion[];
  expect: SanityExpect[];
}

export interface SanitySuite {
  name: string;
  file: string;
  description: string;
  requests: SanityRequest[];
  across: Array<{ check: 'score_increasing'; q: string; requests: string[] }>;
}

export const SANITY_SUITES: SanitySuite[] = [
  {
    "name": "yesno_sentiment",
    "file": "10-yesno-sentiment.json",
    "description": "yesno obvious: six single-sentence states, three clearly positive and three clearly negative. p(positive) must be > 0.8 for the positive ones and < 0.2 for the negative ones.",
    "requests": [
      {
        "id": "pos-1",
        "state": "I absolutely loved this restaurant; the food was delicious and the staff made us feel like family.",
        "questions": [
          {
            "type": "yesno",
            "name": "positive",
            "instructions": "The text expresses positive sentiment"
          }
        ],
        "expect": [
          {
            "q": "positive",
            "check": "p_gt",
            "value": 0.8
          }
        ]
      },
      {
        "id": "pos-2",
        "state": "This is the best phone I have ever owned, and I would happily buy it again tomorrow.",
        "questions": [
          {
            "type": "yesno",
            "name": "positive",
            "instructions": "The text expresses positive sentiment"
          }
        ],
        "expect": [
          {
            "q": "positive",
            "check": "p_gt",
            "value": 0.8
          }
        ]
      },
      {
        "id": "pos-3",
        "state": "What a wonderful concert: every song was beautiful and we left the hall smiling.",
        "questions": [
          {
            "type": "yesno",
            "name": "positive",
            "instructions": "The text expresses positive sentiment"
          }
        ],
        "expect": [
          {
            "q": "positive",
            "check": "p_gt",
            "value": 0.8
          }
        ]
      },
      {
        "id": "neg-1",
        "state": "The hotel was filthy, the staff were rude, and I will never stay there again.",
        "questions": [
          {
            "type": "yesno",
            "name": "positive",
            "instructions": "The text expresses positive sentiment"
          }
        ],
        "expect": [
          {
            "q": "positive",
            "check": "p_lt",
            "value": 0.2
          }
        ]
      },
      {
        "id": "neg-2",
        "state": "This blender broke on the second day and customer service refused to help; a complete waste of money.",
        "questions": [
          {
            "type": "yesno",
            "name": "positive",
            "instructions": "The text expresses positive sentiment"
          }
        ],
        "expect": [
          {
            "q": "positive",
            "check": "p_lt",
            "value": 0.2
          }
        ]
      },
      {
        "id": "neg-3",
        "state": "The movie was painfully boring and the ending made me angry that I had wasted three hours.",
        "questions": [
          {
            "type": "yesno",
            "name": "positive",
            "instructions": "The text expresses positive sentiment"
          }
        ],
        "expect": [
          {
            "q": "positive",
            "check": "p_lt",
            "value": 0.2
          }
        ]
      }
    ],
    "across": []
  },
  {
    "name": "choice_routing",
    "file": "20-choice-routing.json",
    "description": "choice routing: six support messages, options billing/technical/shipping/other. The expected option must be the argmax with confidence > 0.6. One state is a JSON object, exercising the non-string state path.",
    "requests": [
      {
        "id": "billing-1",
        "state": "Hi, I was charged twice for my March invoice. Can you refund the duplicate payment?",
        "questions": [
          {
            "type": "choice",
            "name": "team",
            "instructions": "Which team should handle this message?",
            "options": [
              {
                "name": "billing",
                "description": "Payment, invoice and refund issues"
              },
              {
                "name": "technical",
                "description": "Bugs, errors and things that do not work"
              },
              {
                "name": "shipping",
                "description": "Delivery, tracking and lost or damaged packages"
              },
              {
                "name": "other",
                "description": "Anything else"
              }
            ]
          }
        ],
        "expect": [
          {
            "q": "team",
            "check": "choice_is",
            "value": "billing"
          },
          {
            "q": "team",
            "check": "confidence_gt",
            "value": 0.6
          }
        ]
      },
      {
        "id": "billing-2",
        "state": {
          "channel": "email",
          "subject": "Card declined",
          "message": "My credit card keeps getting declined when I try to renew my subscription, and now my plan says it is overdue."
        },
        "questions": [
          {
            "type": "choice",
            "name": "team",
            "instructions": "Which team should handle this message?",
            "options": [
              {
                "name": "billing",
                "description": "Payment, invoice and refund issues"
              },
              {
                "name": "technical",
                "description": "Bugs, errors and things that do not work"
              },
              {
                "name": "shipping",
                "description": "Delivery, tracking and lost or damaged packages"
              },
              {
                "name": "other",
                "description": "Anything else"
              }
            ]
          }
        ],
        "expect": [
          {
            "q": "team",
            "check": "choice_is",
            "value": "billing"
          },
          {
            "q": "team",
            "check": "confidence_gt",
            "value": 0.6
          }
        ]
      },
      {
        "id": "technical-1",
        "state": "The app crashes every time I open the settings page. I get an error that says 'unexpected null reference'.",
        "questions": [
          {
            "type": "choice",
            "name": "team",
            "instructions": "Which team should handle this message?",
            "options": [
              {
                "name": "billing",
                "description": "Payment, invoice and refund issues"
              },
              {
                "name": "technical",
                "description": "Bugs, errors and things that do not work"
              },
              {
                "name": "shipping",
                "description": "Delivery, tracking and lost or damaged packages"
              },
              {
                "name": "other",
                "description": "Anything else"
              }
            ]
          }
        ],
        "expect": [
          {
            "q": "team",
            "check": "choice_is",
            "value": "technical"
          },
          {
            "q": "team",
            "check": "confidence_gt",
            "value": 0.6
          }
        ]
      },
      {
        "id": "technical-2",
        "state": "Since the last update I can't log in anymore. The login button just spins forever and nothing happens.",
        "questions": [
          {
            "type": "choice",
            "name": "team",
            "instructions": "Which team should handle this message?",
            "options": [
              {
                "name": "billing",
                "description": "Payment, invoice and refund issues"
              },
              {
                "name": "technical",
                "description": "Bugs, errors and things that do not work"
              },
              {
                "name": "shipping",
                "description": "Delivery, tracking and lost or damaged packages"
              },
              {
                "name": "other",
                "description": "Anything else"
              }
            ]
          }
        ],
        "expect": [
          {
            "q": "team",
            "check": "choice_is",
            "value": "technical"
          },
          {
            "q": "team",
            "check": "confidence_gt",
            "value": 0.6
          }
        ]
      },
      {
        "id": "shipping-1",
        "state": "My order was supposed to arrive last Tuesday and the tracking number still shows it sitting in a warehouse in Memphis.",
        "questions": [
          {
            "type": "choice",
            "name": "team",
            "instructions": "Which team should handle this message?",
            "options": [
              {
                "name": "billing",
                "description": "Payment, invoice and refund issues"
              },
              {
                "name": "technical",
                "description": "Bugs, errors and things that do not work"
              },
              {
                "name": "shipping",
                "description": "Delivery, tracking and lost or damaged packages"
              },
              {
                "name": "other",
                "description": "Anything else"
              }
            ]
          }
        ],
        "expect": [
          {
            "q": "team",
            "check": "choice_is",
            "value": "shipping"
          },
          {
            "q": "team",
            "check": "confidence_gt",
            "value": 0.6
          }
        ]
      },
      {
        "id": "other-1",
        "state": "Do you have any job openings for graphic designers? I'd love to send you my portfolio.",
        "questions": [
          {
            "type": "choice",
            "name": "team",
            "instructions": "Which team should handle this message?",
            "options": [
              {
                "name": "billing",
                "description": "Payment, invoice and refund issues"
              },
              {
                "name": "technical",
                "description": "Bugs, errors and things that do not work"
              },
              {
                "name": "shipping",
                "description": "Delivery, tracking and lost or damaged packages"
              },
              {
                "name": "other",
                "description": "Anything else"
              }
            ]
          }
        ],
        "expect": [
          {
            "q": "team",
            "check": "choice_is",
            "value": "other"
          },
          {
            "q": "team",
            "check": "confidence_gt",
            "value": 0.6
          }
        ]
      }
    ],
    "across": []
  },
  {
    "name": "score_anger",
    "file": "30-score-anger.json",
    "description": "score ordered: three messages of rising anger scored on Calm / Frustrated but civil / Very angry. The expected values (score) must be strictly increasing across the three.",
    "requests": [
      {
        "id": "calm",
        "state": "Hello! Just checking whether my order has shipped yet. No rush at all, thanks so much.",
        "questions": [
          {
            "type": "score",
            "name": "anger",
            "instructions": "How angry is the customer?",
            "levels": [
              "Calm",
              "Frustrated but civil",
              "Very angry"
            ]
          }
        ],
        "expect": []
      },
      {
        "id": "civil",
        "state": "This is the third time I've asked about my order. I'm getting frustrated. Please give me a real answer today.",
        "questions": [
          {
            "type": "score",
            "name": "anger",
            "instructions": "How angry is the customer?",
            "levels": [
              "Calm",
              "Frustrated but civil",
              "Very angry"
            ]
          }
        ],
        "expect": []
      },
      {
        "id": "angry",
        "state": "THIS IS UNACCEPTABLE!!! You've ignored me for three weeks, you stole my money, and I am furious. Fix this NOW or I'm reporting you!",
        "questions": [
          {
            "type": "score",
            "name": "anger",
            "instructions": "How angry is the customer?",
            "levels": [
              "Calm",
              "Frustrated but civil",
              "Very angry"
            ]
          }
        ],
        "expect": []
      }
    ],
    "across": [
      {
        "check": "score_increasing",
        "q": "anger",
        "requests": [
          "calm",
          "civil",
          "angry"
        ]
      }
    ]
  }
];
