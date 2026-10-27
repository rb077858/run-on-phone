// Offline stand-in for aki-api, used when AKI_MOCK=1 (UI development and smoke tests).
const QUESTIONS = [
  "האם הדמות שלך אמיתית?",
  "האם הדמות שלך היא גבר?",
  "האם הדמות שלך מופיעה בסרט?",
  "האם הדמות שלך משתמשת בקסם?",
  "האם הדמות שלך מרכיבה משקפיים?",
  "האם לדמות שלך יש צלקת?",
];
const ANSWERS = ["כן", "לא", "לא יודע", "כנראה", "כנראה שלא"];

class MockAki {
  constructor({ region }) {
    this.region = region;
    this.currentStep = 0;
    this.progress = 0;
    this.question = "";
    this.answers = [];
  }
  async start() {
    this.question = QUESTIONS[0];
    this.answers = ANSWERS;
    return this;
  }
  async step() {
    this.currentStep++;
    this.progress = Math.min(99, this.currentStep * 19);
    if (this.currentStep === 5) {
      return {
        id_base_proposition: "1",
        name_proposition: "הארי פוטר",
        description_proposition: "קוסם צעיר",
        photo: "",
      };
    }
    this.question = QUESTIONS[this.currentStep % QUESTIONS.length];
    return { question: this.question, step: String(this.currentStep), progression: String(this.progress) };
  }
  async back() {
    this.currentStep = Math.max(0, this.currentStep - 1);
    this.progress = this.currentStep * 19;
    this.question = QUESTIONS[this.currentStep];
    return { question: this.question, step: String(this.currentStep), progression: String(this.progress) };
  }
  async continue() {
    this.progress = 50;
    this.question = QUESTIONS[2];
    return { question: this.question, step: String(this.currentStep), progression: "50" };
  }
}

module.exports = MockAki;
