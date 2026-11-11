// Made-up finance chats with what a person would label each follow-up. Written before the classifier was tuned.
// These are NOT real chats, so an accuracy figure on them says little about real use.
export const SCENES = {
  earnings: {
    user: "Summarize the Q3 earnings call for Acme Corp for our clients",
    assistant: "Acme Corp reported Q3 revenue of $1.2 billion, up 8% year over year, with operating margin of 21%. Management raised full-year guidance and highlighted growth in cloud services. Risks include rising input costs.",
  },
  formula: {
    user: "Write an Excel formula that computes CAGR from cells B2 to B6 over five years",
    assistant: "Use =(B6/B2)^(1/5)-1 and format the cell as a percentage.",
  },
  email: {
    user: "Draft an email to the client about the delayed settlement",
    assistant: "Subject: Settlement delay. Dear client, we regret to inform you that your settlement has been delayed by two days due to a system issue. We apologize for any inconvenience.",
  },
};

export const CASES = [
  ["earnings", "The revenue figure is wrong, it was $1.1 billion", "correction"],
  ["earnings", "Make it shorter, three bullets max", "correction"],
  ["earnings", "Also add a line about the dividend", "extension"],
  ["earnings", "Why did you say operating margin was 21%?", "question"],
  ["earnings", "Thanks, looks good", "acceptance"],
  ["earnings", "Now write a client email announcing the Beta Corp merger, three paragraphs, formal tone, include the deal terms of $4.5 billion in cash and the expected closing in March", "new_task"],
  ["earnings", "Can you rewrite it in a more formal tone", "correction"],
  ["earnings", "You forgot the disclaimer, please add the standard disclosure line", "correction"],
  ["earnings", "Use 'clients' not 'customers'", "correction"],
  ["earnings", "What is the guidance for next year?", "question"],
  ["earnings", "Separately, can you draft talking points for the Delta Inc call tomorrow", "new_task"],
  ["earnings", "The table is missing the Q2 comparison column", "correction"],
  ["earnings", "Remove the last paragraph", "correction"],
  ["earnings", "That's not what I asked for, I wanted a comparison of Acme and Beta", "correction"],
  ["earnings", "ok", "acceptance"],
  ["earnings", "Also include a chart of revenue by segment", "extension"],
  ["earnings", "Make the tone less robotic", "correction"],
  ["formula", "That gives me a #DIV/0 error", "correction"],
  ["formula", "It should be 4 periods not 5 since there are five data points", "correction"],
  ["formula", "What does the caret do in that formula?", "question"],
  ["formula", "Can you explain why you used B6/B2?", "question"],
  ["formula", "Now write a VBA macro that emails the Treasury team a daily PDF of the balance sheet", "new_task"],
  ["formula", "Perfect, that works", "acceptance"],
  ["formula", "The formula returns 0.12 but I expected 12%", "correction"],
  ["email", "Don't say 'we regret to inform you', it's too stiff", "correction"],
  ["email", "Use the client's name, Ms. Patel", "correction"],
  ["email", "Who should I cc on this?", "question"],
  ["email", "Thanks!", "acceptance"],
  ["email", "Help me prepare a one page memo on Basel III capital requirements for the risk committee", "new_task"],
  ["email", "Make it more apologetic", "correction"],
  ["email", "Shorter please", "correction"],
  ["email", "Quick question about the Brazil bond auction results from yesterday", "new_task", 3 * 3600],
  ["email", "It's still too long", "correction"],
];

// A second set, written AFTER the classifier was tuned on the first, with different scenes. Still made up.
export const SCENES2 = {
  memo: {
    user: "Write a one page memo on liquidity coverage ratio changes for the risk committee",
    assistant: "Memo: The liquidity coverage ratio requirement rises next quarter. Treasury should hold more high quality liquid assets. We expect a modest drag on net interest margin and recommend phasing the change over two quarters.",
  },
  slides: {
    user: "Create three bullets for a slide on our Q2 trading desk performance",
    assistant: "Desk revenue grew 12% quarter over quarter. Volatility drove higher client activity in rates. Cost to income ratio improved to 58%.",
  },
  recon: {
    user: "Explain how to reconcile the custody account against the general ledger",
    assistant: "Export both balances, match on trade date and security ID, then investigate breaks over the materiality threshold and document each adjustment.",
  },
};
export const CASES2 = [
  ["memo", "The ratio rises this quarter, not next quarter", "correction"],
  ["memo", "Too many acronyms, spell them out", "correction"],
  ["memo", "Does the committee need to approve the phasing?", "question"],
  ["memo", "Draft a separate checklist for onboarding a new prime broker, with KYC, credit limits and ISDA documentation", "new_task"],
  ["memo", "Great, send that over", "acceptance"],
  ["memo", "Also mention the impact on funding costs", "extension"],
  ["slides", "The cost to income ratio is 61%, not 58%", "correction"],
  ["slides", "Can you make the second bullet punchier", "correction"],
  ["slides", "What was the volatility index level you referenced?", "question"],
  ["slides", "Next task: summarize the Fed minutes released this afternoon", "new_task"],
  ["slides", "Add a fourth bullet about headcount", "extension"],
  ["recon", "Step three is unclear, give an example with real numbers", "correction"],
  ["recon", "What counts as a material break?", "question"],
  ["recon", "Now I need a Python script that pulls FX rates from the ECB feed and writes them to a CSV", "new_task"],
  ["recon", "That's right, thank you", "acceptance"],
  ["recon", "It leaves out the step for pending trades", "correction"],
];
