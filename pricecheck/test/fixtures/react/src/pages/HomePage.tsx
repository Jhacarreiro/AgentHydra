import { lazy } from 'react'
import { FormattedMessage } from 'react-intl'
import { Banner } from '../components/Banner'
import { FeatureCard } from './FeatureCard'

const Settings = lazy(() => import('../components/Settings'))

export default function HomePage({ user }: { user: string }) {
  return (
    <section className="home">
      <h1>Hello, {user}</h1>
      <FormattedMessage id="home.intro" />
      <Banner />
      {user && <button onClick={() => {}}>Open menu</button>}
      <FeatureCard />
      <Settings />
      <a href="https://other-product.example.com">Other product</a>
    </section>
  )
}
