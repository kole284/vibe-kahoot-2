'use client';

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  Game, 
  Answer, 
  Team, 
  getDb, 
  updateGameData, 
  GameStatus, 
  getTeamsForGame, 
  getTeamAnswerResult, 
  Question, 
  getAllScoresForGame,
  TeamScore
} from '../lib/firebase';
import Logo from '../components/Logo';
import AnimatedBackground from '../components/AnimatedBackground';
import { onValue, ref, update, Database } from 'firebase/database';
import { Button } from '../components/ui/button';
import { useGameRealtimeState } from '../hooks/useGameRealtimeState';
import { getMascotImageUrl } from '../lib/utils';

// Interface for the processed answer data we want to display
interface TeamAnswerDisplay {
  teamId: string;
  teamName: string;
  selectedAnswer: string | null; // Null if unanswered
  isCorrect: boolean | null;    // Null if unanswered
  pointsAwarded: number | null; // Null if unanswered
  answerIndex: number | null;   // Null if unanswered
}

// Interface for ranked teams (similar to AdminLeaderboardPage)
interface RankedTeam extends Team {
  rank: number;
}

const QUESTIONS_PER_CATEGORY = 8; // Define category size

const AdminAnswerRevealPage = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
  const [teamAnswers, setTeamAnswers] = useState<TeamAnswerDisplay[]>([]);
  const [rankedTeams, setRankedTeams] = useState<RankedTeam[]>([]); // State for ranked teams
  const [isLastQuestion, setIsLastQuestion] = useState(false); // State to know if it's the last question
  const [isNavigating, setIsNavigating] = useState(false); // Add state to prevent double nav
  
  const gameCode = localStorage.getItem('gameCode');
  const { gameData: game, error: gameError, loading: gameLoading } = useGameRealtimeState(gameCode);
  
  useEffect(() => {
    if (!gameCode) {
      setError("Missing game code. Redirecting...");
      setTimeout(() => navigate('/admin'), 1500);
      return;
    }

    if (gameLoading || gameError || !game) {
      setLoading(true);
      return;
    }

    // WAIT for the correct status AND results to be ready!
    if (game.status !== 'answer_reveal' || game.resultsReady !== true) {
      console.log(`AdminAnswerRevealPage: Waiting. Status: ${game.status}, Results Ready: ${game.resultsReady}`);
      // Show loading only if we are expecting results soon (status is reveal but results not ready)
      setLoading(game.status === 'answer_reveal'); 
      // Removed the state clearing logic here as navigation should handle unmounting
      return; // Return early if not the right status/ready state
    }

    // --- Proceed only if status is 'answer_reveal' and resultsReady is true --- 
    const processAndFetchData = async () => {
      setLoading(true);
      console.log('AdminAnswerRevealPage: Processing answers and ranks for reveal...');
      try {
        // --- 1. Get Current Question Data --- 
        const currentQuestionIndex = game.currentQuestionIndex;
        if (currentQuestionIndex < 0 || currentQuestionIndex >= game.questionOrder.length) {
           throw new Error("Invalid current question index.");
        }
        const currentQuestionId = game.questionOrder[currentQuestionIndex];
        const questionData = game.questions.find(q => q.id === currentQuestionId);
        if (!questionData) {
          throw new Error("Current question data not found in game state.");
        }
        setCurrentQuestion(questionData);
        setIsLastQuestion(currentQuestionIndex >= game.questionOrder.length - 1);

        // --- 2. Get ALL Active Teams --- 
        const allTeamsForGame = await getTeamsForGame(gameCode);
        const activeTeams = allTeamsForGame.filter(team => team.isActive !== false);
        console.log(`AdminAnswerRevealPage: Found ${activeTeams.length} active teams.`);

        // --- 3. Get Processed Answers for THIS Question (Handles null) --- 
        const answerPromises = activeTeams.map(async (team) => {
            const result = await getTeamAnswerResult(gameCode, currentQuestionId, team.id);
            return { team, result }; // Return both team and result (or null)
        });
        
        const teamResults = await Promise.all(answerPromises);

        const processedAnswersArray: TeamAnswerDisplay[] = teamResults.map(({ team, result }) => {
            if (result) {
                // Team answered and result is processed
                return {
                    teamId: team.id,
                    teamName: team.name || `Team ${team.id.substring(0, 4)}`,
                    selectedAnswer: result.selectedAnswer,
                    isCorrect: result.isCorrect,
                    pointsAwarded: result.pointsAwarded,
                    answerIndex: result.answerIndex
                };
            } else {
                // Team did not answer (result is null)
                return {
                    teamId: team.id,
                    teamName: team.name || `Team ${team.id.substring(0, 4)}`,
                    selectedAnswer: "nije odgovoreno", // Display text for unanswered
                    isCorrect: null,
                    pointsAwarded: 0, // Award 0 points explicitly here for sorting/display
                    answerIndex: -1
                };
            }
        });

        // Sort: Correct answers first, then by points (highest first), then alphabetically
        processedAnswersArray.sort((a, b) => {
            const aCorrect = a.isCorrect ?? false;
            const bCorrect = b.isCorrect ?? false;
            if (aCorrect !== bCorrect) return bCorrect ? 1 : -1; // Correct answers first
            const aPoints = a.pointsAwarded ?? 0;
            const bPoints = b.pointsAwarded ?? 0;
            if (aPoints !== bPoints) return bPoints - aPoints; // Higher points first
            return a.teamName.localeCompare(b.teamName); // Alphabetical for ties
        });
        
        setTeamAnswers(processedAnswersArray);

        // --- 4. Fetch ALL Current Scores --- 
        const allScores = await getAllScoresForGame(gameCode);
        console.log("AdminAnswerRevealPage: Fetched scores:", allScores);

        // --- 5. Combine Active Teams with their latest Scores --- 
        const teamsWithScores = activeTeams.map(team => ({
          ...team,
          points: allScores[team.id]?.totalScore || 0 // Get score from fetched scores, default to 0
        }));

        // --- 6. Calculate Overall Ranks using combined data --- 
        const teamsArray = [...teamsWithScores]
          .sort((a, b) => b.points - a.points); // Sort by combined points

        const rankedTeamsData: RankedTeam[] = [];
        if (teamsArray.length > 0) {
          let currentRank = 1;
          let previousPoints = teamsArray[0].points;
          teamsArray.forEach((team, index) => {
            if (index > 0 && team.points < previousPoints) {
              currentRank = index + 1;
              previousPoints = team.points;
            }
            // Note: We push the team object from teamsWithScores which has the correct points
            rankedTeamsData.push({ ...team, rank: currentRank }); 
          });
        }
        setRankedTeams(rankedTeamsData);

        setError(null);
      } catch (err: any) {
          console.error("Error processing answers/ranks for reveal:", err);
          setError(`Error processing data: ${err.message}`);
      } finally {
          setLoading(false);
      }
    };

    processAndFetchData();

  }, [game, gameLoading, gameError, gameCode, navigate]); // Rerun when game data changes
  
  const handleNextStep = async () => {
    if (!gameCode || !game || !game.questionOrder || isNavigating) return; // Prevent double click

    setIsNavigating(true); // Indicate navigation process started

    const currentQuestionIndex = game.currentQuestionIndex;
    const totalQuestions = game.questionOrder.length;
    const nextQuestionIndex = currentQuestionIndex + 1;
    const isEndOfGame = nextQuestionIndex >= totalQuestions;
    const isBreakTime = (nextQuestionIndex > 0) && (nextQuestionIndex % QUESTIONS_PER_CATEGORY === 0) && !isEndOfGame;

    let nextStatus: GameStatus;
    let nextRoute: string;
    const updates: Partial<Game> = {};
    let shouldNavigate = true; // Flag to control navigation after update

    if (isEndOfGame) {
      nextStatus = 'game_end';
      nextRoute = `/admin/winners?gameCode=${gameCode}`;
      updates.status = nextStatus;
      console.log(`[AdminAnswerRevealPage] Preparing for game_end.`);
    } else if (isBreakTime) {
      nextStatus = 'leaderboard'; // Set status to trigger break
      nextRoute = `/admin/break?gameCode=${gameCode}`; // Store route for later
      updates.status = nextStatus;
      console.log(`[AdminAnswerRevealPage] Preparing for break.`);
      // Navigation will be handled by useEffect reacting to status change
      shouldNavigate = false; 
    } else {
      nextStatus = 'question_display';
      nextRoute = `/admin/question?gameCode=${gameCode}`;
      updates.status = nextStatus;
      updates.currentQuestionIndex = nextQuestionIndex;
      updates.resultsReady = false;
      console.log(`[AdminAnswerRevealPage] Preparing for next question.`);
    }
      
    try {
      console.log(`[AdminAnswerRevealPage] Updating game state:`, updates);
      await updateGameData(gameCode, updates);
      console.log(`[AdminAnswerRevealPage] Game state updated.`);
      
      // Navigate immediately ONLY if not going to break page
      if (shouldNavigate) {
         console.log(`[AdminAnswerRevealPage] Navigating immediately to ${nextRoute}`);
         navigate(nextRoute); 
      } else {
         // If going to break, navigation is handled by useEffect
         // Reset isNavigating flag here as the next step is handled by useEffect
         setIsNavigating(false);
      }

    } catch (err) {
      setError("Failed to update game state");
      console.error(err);
      setIsNavigating(false); // Reset on error
    }
    // If navigation happens immediately, isNavigating will be reset when component unmounts
  };
  
  // NEW useEffect to handle navigation to BreakPage after status update
  useEffect(() => {
    // Check if the status is leaderboard and we weren't already navigating
    if (game?.status === 'leaderboard' && !isNavigating) {
        // Check if the intended next step was indeed the break page
        // We deduce this: if status is leaderboard, it must have come from the isBreakTime logic
        const currentQuestionIndex = game.currentQuestionIndex;
        const totalQuestions = game.questionOrder.length;
        const nextQuestionIndex = currentQuestionIndex + 1;
        const isEndOfGame = nextQuestionIndex >= totalQuestions;
        const shouldBeBreakTime = (nextQuestionIndex > 0) && (nextQuestionIndex % QUESTIONS_PER_CATEGORY === 0) && !isEndOfGame;
        
        if (shouldBeBreakTime) {
            console.log("[AdminAnswerRevealPage] Status changed to leaderboard, navigating to break page.");
            setIsNavigating(true); // Prevent potential race conditions
            navigate(`/admin/break?gameCode=${gameCode}`);
        }
    }
  }, [game?.status, gameCode, navigate, isNavigating, game?.currentQuestionIndex, game?.questionOrder?.length]);

  const displayError = error || gameError?.message;

  // Derive correct answer text more explicitly
  let derivedCorrectAnswerText = 'N/A'; // Default
  if (currentQuestion) {
      if (currentQuestion.category === 'Pogodite crtani') {
          // For this category, directly use the correctAnswer field
          derivedCorrectAnswerText = currentQuestion.correctAnswer || 'Greška: Tačan odgovor nedostaje u podacima pitanja';
      } else if (currentQuestion.options && typeof currentQuestion.correctAnswerIndex === 'number' && currentQuestion.correctAnswerIndex >= 0) {
          // For other categories, use the index
          derivedCorrectAnswerText = currentQuestion.options[currentQuestion.correctAnswerIndex];
      } else if (currentQuestion.correctAnswer) {
          // Fallback for potentially malformed non-text questions that might have correctAnswer
           derivedCorrectAnswerText = currentQuestion.correctAnswer;
      }
  }

  if (displayError) {
    return (
      <div className="min-h-screen bg-primary flex flex-col items-center justify-center p-4">
        <div className="bg-red-500/20 border border-red-500/50 text-red-100 p-4 rounded-lg max-w-md text-center">
          <p className="text-lg font-bold mb-2">Error</p>
          <p>{displayError}</p>
        </div>
        <button 
          onClick={() => navigate('/admin')}
          className="mt-4 text-accent underline"
        >
          Return to Admin Page
        </button>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-primary p-8 relative overflow-hidden">
      <AnimatedBackground density="low" />
      
      <motion.div 
        className="absolute top-0 left-0 z-40 m-2 ml-16"
        initial={{ opacity: 0, x: -10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.6 }}
        
      >
        <Logo size="large" className="w-28 h-28 md:w-48 md:h-48" onClick={() => navigate('/admin')} />
      </motion.div>
      
      <motion.div
        className="absolute top-6 right-6 z-40"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        style={{ transformOrigin: 'center' }}
      >
        <Button
          onClick={handleNextStep}
          className="rounded-full w-20 h-20 md:w-28 md:h-28 flex items-center justify-center bg-secondary hover:bg-secondary/90"
        >
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            className="h-12 w-12 md:h-16 md:w-16 text-white" 
            fill="none" 
            viewBox="0 0 24 24" 
            stroke="currentColor"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M14 5l7 7m0 0l-7 7m7-7H3" 
            />
          </svg>
        </Button>
      </motion.div>
      
      <div className="h-full flex flex-col max-w-6xl mx-auto pt-16">
        {loading || gameLoading ? (
          <div className="flex justify-center items-center h-full">
            <motion.div
              className="w-16 h-16 border-4 border-accent rounded-full border-t-transparent"
              animate={{ rotate: 360 }}
              transition={{
                duration: 1.5,
                repeat: Infinity,
                ease: "linear"
              }}
            />
          </div>
        ) : game && currentQuestion && (
          <motion.div
            className="w-full space-y-6 z-30"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {/* --- Question & Answer Info --- */}
            <div className="bg-secondary/20 p-8 rounded-xl backdrop-blur-md mb-8 text-center shadow-lg">
              <h2 className="text-2xl md:text-3xl font-bold text-accent mb-4 font-serif">
                pitanje {game.currentQuestionIndex + 1}:
              </h2>
              <p className="text-xl md:text-2xl lg:text-3xl text-accent/95 mb-6 font-serif leading-relaxed">
                {currentQuestion.text}
              </p>
              <div className="border-t-2 border-accent/30 pt-5 mt-5">
                <p className="text-lg md:text-3xl text-accent/80 mb-2">tačan odgovor je:</p>
                <p className="text-3xl md:text-5xl font-bold text-highlight tracking-wide">
                  {derivedCorrectAnswerText} 
                </p>
              </div>
            </div>
            
            {/* --- Combined Answers and Leaderboard Section --- */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
              {/* Section 1: Individual Team Answers for this Question */}
              <div className="space-y-4 bg-primary/40 backdrop-blur-sm p-5 rounded-lg shadow-md">
                <h3 className="text-xl md:text-3xl font-semibold text-accent mb-4 border-b border-accent/20 pb-3">odgovori timova:</h3>
                {teamAnswers.length > 0 ? (
                  teamAnswers.length > 4 ? (
                    // Multi-column layout for more than 4 teams
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 ">
                      {teamAnswers.map((answer, index) => (
                        <motion.div
                          key={answer.teamId}
                          className={`p-3 rounded-lg flex justify-between items-center transition-colors duration-300 
                            ${answer.isCorrect === null 
                              ? 'bg-gray-500/30 border border-gray-400/40' // Gray for unanswered (isCorrect is null)
                              : answer.isCorrect 
                                ? 'bg-green-700/30 border border-highlight/40' // Green for correct
                                : 'bg-red-500/30 border border-red-400/40' // Red for incorrect
                            }`}
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: index * 0.05 }}
                        >
                          <div className="flex-1 mr-2 min-w-0">
                            <span className="font-bold text-accent text-base block truncate mb-1" title={answer.teamName}>{answer.teamName}</span>
                            <span className={`text-sm ${answer.isCorrect === null ? 'text-accent/60 italic' : 'text-accent/80'}`}>
                              {answer.selectedAnswer} {/* Will show "Nije odgovoreno" if null */}
                            </span>
                          </div>
                          {/* Only show points if they answered */}
                          {answer.isCorrect !== null && (
                            <span className={`font-bold text-base text-2xl  whitespace-nowrap ${answer.isCorrect ? 'text-highlight' : 'text-accent/90'}`}>
                              +{answer.pointsAwarded ?? 0}
                            </span>
                          )}
                        </motion.div>
                      ))}
                    </div>
                  ) : (
                    // Single column layout for 4 or fewer teams
                    teamAnswers.map((answer, index) => (
                      <motion.div
                        key={answer.teamId}
                        className={`p-4 rounded-lg flex justify-between items-center transition-colors duration-300 
                          ${answer.isCorrect === null 
                            ? 'bg-gray-500/30 border border-gray-400/40' // Gray for unanswered (isCorrect is null)
                            : answer.isCorrect 
                              ? 'bg-green-700/30 border border-highlight/40' // Green for correct
                              : 'bg-red-500/30 border border-red-400/40' // Red for incorrect
                          }`}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.05 }}
                      >
                        <div className="flex-1 mr-4 min-w-0">
                          <span className="font-bold text-accent text-lg block truncate mb-1" title={answer.teamName}>{answer.teamName}</span>
                          <span className={`text-m ${answer.isCorrect === null ? 'text-accent/60 italic' : 'text-accent/80'}`}>
                            odgovor: {answer.selectedAnswer} {/* Will show "Nije odgovoreno" if null */}
                          </span>
                        </div>
                        {/* Only show points if they answered */}
                        {answer.isCorrect !== null && (
                          <span className={`font-bold text-xl whitespace-nowrap ${answer.isCorrect ? 'text-highlight' : 'text-accent/90'}`}>
                            +{answer.pointsAwarded ?? 0} pts
                          </span>
                        )}
                      </motion.div>
                    ))
                  )
                ) : (
                  <p className="text-accent/60 italic text-center py-5">Nema aktivnih timova.</p>
                )}
              </div>

              {/* Section 2: Overall Leaderboard */}
              <div className="space-y-4 bg-primary/40 backdrop-blur-sm p-5 rounded-lg shadow-md">
                <h3 className="text-xl md:text-3xl font-semibold text-accent mb-4 border-b border-accent/20 pb-3">trenutna rang lista:</h3>
                {rankedTeams.length > 0 ? (
                  rankedTeams.length > 4 ? (
                    // Multi-column layout for more than 4 teams
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {rankedTeams.map((team, index) => (
                        <motion.div
                          key={team.id}
                          className={`p-3 rounded-lg flex items-center 
                            bg-secondary/20 border 
                            ${index === 0 ? 'border-yellow-400/70 shadow-md shadow-yellow-500/20' : 
                              index === 1 ? 'border-gray-400/70' : 
                              index === 2 ? 'border-amber-600/70' : 'border-secondary/30'}` 
                          }
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: index * 0.05 }}
                        >
                          <img 
                            src={getMascotImageUrl(team.mascotId)}
                            alt={`${team.name} mascot`} 
                            className="w-8 h-8 mr-3 flex-shrink-0 rounded-full object-cover border-2 border-accent/30"
                          />
                          <div className="flex-1 min-w-0 mr-2">
                            <span className="font-bold text-accent text-xl block truncate">{team.name}</span>
                          </div>
                          <div className="text-xl font-bold text-accent whitespace-nowrap">
                            {team.points}
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  ) : (
                    // Single column layout for 4 or fewer teams
                    rankedTeams.map((team, index) => (
                      <motion.div
                        key={team.id}
                        className={`p-4 rounded-lg flex items-center 
                          bg-secondary/20 border 
                          ${index === 0 ? 'border-yellow-400/70 shadow-md shadow-yellow-500/20' : 
                            index === 1 ? 'border-gray-400/70' : 
                            index === 2 ? 'border-amber-600/70' : 'border-secondary/30'}` 
                        }
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.05 }}
                      >
                        <img 
                          src={getMascotImageUrl(team.mascotId)}
                          alt={`${team.name} mascot`} 
                          className="w-10 h-10 mr-4 flex-shrink-0 rounded-full object-cover border-2 border-accent/30"
                        />
                        <div className="flex-1 min-w-0 mr-3">
                          <span className="font-bold text-accent text-lg block truncate">{team.name}</span>
                        </div>
                        <div className="text-2xl font-bold text-accent whitespace-nowrap">
                          {team.points} pts
                        </div>
                      </motion.div>
                    ))
                  )
                ) : (
                   <p className="text-accent/60 italic text-center py-5">Nema timova za prikaz.</p>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default AdminAnswerRevealPage; 