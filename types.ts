
export interface Question {
  id: number;
  mission: number; // 1 to 5
  text: string;
  options: string[];
  correctAnswer: string;
  hint: string;
  explanation: string;
  translation: string;
}

export type FeedbackType = 'none' | 'success' | 'hint' | 'error';

export interface GameState {
  gameStarted: boolean;
  activeMission: number;
  currentQuestionIndex: number; 
  userAnswer: string;
  attempts: number;
  score: number;
  feedbackType: FeedbackType;
  feedbackMessage: string;
  isGameOver: boolean;
  showExplanation: boolean;
}
