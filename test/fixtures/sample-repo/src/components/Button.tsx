import React, { useState } from "react";

export interface ButtonProps {
  label: string;
  onClick?: () => void;
}

export const Button = ({ label, onClick }: ButtonProps): JSX.Element => {
  const [pressed, setPressed] = useState(false);
  return (
    <button onClick={() => { setPressed(!pressed); onClick?.(); }}>
      {label}
    </button>
  );
};

export default function App() {
  return <Button label="Hello" />;
}
