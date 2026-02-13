const startInSeconds = 60;
let remainingSeconds = startInSeconds;

const formatTime = (totalSeconds) => {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

console.log(`Start odliczania: ${formatTime(remainingSeconds)}`);

const timer = setInterval(() => {
  remainingSeconds -= 1;

  if (remainingSeconds <= 0) {
    console.log("Czas minął: 00:00");
    clearInterval(timer);
    return;
  }

  console.log(`Pozostało: ${formatTime(remainingSeconds)}`);
}, 1000);
